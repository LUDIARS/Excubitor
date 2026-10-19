/**
 * 外部に出られない拠点の更新元: 依頼元拠点から git bundle を受け取り、 main を fast-forward する。
 *
 * 手順: 手元 HEAD を have として bundle を取得 → `git bundle verify` (前提コミットが手元にあるか)
 * → `refs/remotes/mesh/main` へ fetch → `merge --ff-only`。
 * 依頼元から受け取れるのは main だけなので、 main 以外を checkout している repo は更新しない。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execCapture } from '../../shared/exec.js';
import { syncSubmodules, tail, type StepResult } from '../../update/steps.js';
import { downloadBundle, type BundleDownloadResult } from '../client.js';
import type { RemotePeer } from '../store.js';
import { fileSha256, requireApprovedBundle } from '../security/artifact.js';

/** @implements SPEC-FEDERATION-MESH-SOURCE */

const GIT_TIMEOUT_MS = 5 * 60 * 1000;
export const MESH_REMOTE_REF = 'refs/remotes/mesh/main';

export interface MeshSourceDeps {
  download?: (peer: RemotePeer, repo: string, have: string | null, dest: string) => Promise<BundleDownloadResult>;
  exec?: typeof execCapture;
  approve?: typeof requireApprovedBundle;
}

export async function fastForwardFromMesh(
  peer: RemotePeer,
  repo: string,
  repoDir: string,
  branch: string,
  deps: MeshSourceDeps = {},
): Promise<StepResult[]> {
  const exec = deps.exec ?? execCapture;
  const download = deps.download ?? downloadBundle;
  if (branch !== 'main') {
    return [{ step: 'mesh_branch', ok: false, detail: `依頼元から受け取れるのは main だけです (この checkout は ${branch})` }];
  }

  const dir = await mkdtemp(join(tmpdir(), 'excubitor-mesh-'));
  const file = join(dir, 'main.bundle');
  const steps: StepResult[] = [];
  try {
    const got = await download(peer, repo, null, file);
    steps.push({
      step: 'mesh_fetch',
      ok: got.ok,
      detail: got.ok ? (got.upToDate ? `already up to date with ${peer.name}` : `bundle from ${peer.name}`) : (got.error ?? 'download failed'),
    });
    if (!got.ok) return steps;
    if (got.upToDate) return [{ step: 'mesh_approval', ok: false, detail: 'approved full bundle required' }];
    try {
      await (deps.approve ?? requireApprovedBundle)(repo, file);
    } catch {
      // 承認手順 (spec SPEC-SECURITY-MESH-BUNDLE-APPROVAL) のため、管理者が照合する digest と main の commit を残す。
      // ここでは bundle を取り込まない (list-heads は bundle のヘッダを読むだけ)。
      const digest = await fileSha256(file).catch(() => 'unknown');
      const heads = await exec('git', ['bundle', 'list-heads', file, 'refs/heads/main'], repoDir, GIT_TIMEOUT_MS);
      const head = heads.ok ? heads.stdout.trim().split(/\s+/)[0] ?? 'unknown' : 'unknown';
      steps.push({ step: 'mesh_approval', ok: false,
        detail: `bundle is not approved by the local administrator (sha256=${digest}, main=${head})` });
      return steps;
    }

    const verify = await exec('git', ['bundle', 'verify', file], repoDir, GIT_TIMEOUT_MS);
    steps.push({ step: 'mesh_verify', ok: verify.ok, detail: tail(verify.ok ? verify.stdout : verify.stderr) });
    if (!verify.ok) return steps;

    const fetch = await exec('git', ['fetch', '--quiet', file, `+refs/heads/main:${MESH_REMOTE_REF}`], repoDir, GIT_TIMEOUT_MS);
    steps.push({ step: 'mesh_import', ok: fetch.ok, detail: tail(fetch.stderr || fetch.stdout) });
    if (!fetch.ok) return steps;

    const merge = await exec('git', ['merge', '--ff-only', MESH_REMOTE_REF], repoDir, GIT_TIMEOUT_MS);
    steps.push({ step: 'pull', ok: merge.ok, detail: tail(merge.ok ? merge.stdout : (merge.stderr || 'ff-only マージ不可 (分岐あり)')) });
    if (!merge.ok) return steps;
    // bundle は親リポの履歴だけを運ぶ。 submodule の版が変わっていれば取得が要り、 外へ出られない
    // 拠点ではここで失敗として表に出る (黙って古い submodule のまま build させない)。
    const submodules = await syncSubmodules(repoDir, exec);
    if (submodules) steps.push(submodules);
    return steps;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
