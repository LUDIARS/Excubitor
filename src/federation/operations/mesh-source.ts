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
import { tail, type StepResult } from '../../update/steps.js';
import { downloadBundle, type BundleDownloadResult } from '../client.js';
import type { RemotePeer } from '../store.js';

/** @implements SPEC-FEDERATION-MESH-SOURCE */

const GIT_TIMEOUT_MS = 5 * 60 * 1000;
export const MESH_REMOTE_REF = 'refs/remotes/mesh/main';

export interface MeshSourceDeps {
  download?: (peer: RemotePeer, repo: string, have: string | null, dest: string) => Promise<BundleDownloadResult>;
  exec?: typeof execCapture;
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

  const head = await exec('git', ['rev-parse', 'HEAD'], repoDir, GIT_TIMEOUT_MS);
  const have = head.ok ? head.stdout.trim() : null;
  const dir = await mkdtemp(join(tmpdir(), 'excubitor-mesh-'));
  const file = join(dir, 'main.bundle');
  const steps: StepResult[] = [];
  try {
    const got = await download(peer, repo, have, file);
    steps.push({
      step: 'mesh_fetch',
      ok: got.ok,
      detail: got.ok ? (got.upToDate ? `already up to date with ${peer.name}` : `bundle from ${peer.name}`) : (got.error ?? 'download failed'),
    });
    if (!got.ok || got.upToDate) return steps;

    const verify = await exec('git', ['bundle', 'verify', file], repoDir, GIT_TIMEOUT_MS);
    steps.push({ step: 'mesh_verify', ok: verify.ok, detail: tail(verify.ok ? verify.stdout : verify.stderr) });
    if (!verify.ok) return steps;

    const fetch = await exec('git', ['fetch', '--quiet', file, `+refs/heads/main:${MESH_REMOTE_REF}`], repoDir, GIT_TIMEOUT_MS);
    steps.push({ step: 'mesh_import', ok: fetch.ok, detail: tail(fetch.stderr || fetch.stdout) });
    if (!fetch.ok) return steps;

    const merge = await exec('git', ['merge', '--ff-only', MESH_REMOTE_REF], repoDir, GIT_TIMEOUT_MS);
    steps.push({ step: 'pull', ok: merge.ok, detail: tail(merge.ok ? merge.stdout : (merge.stderr || 'ff-only マージ不可 (分岐あり)')) });
    return steps;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
