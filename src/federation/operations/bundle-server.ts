/**
 * 依頼元拠点として、 外部に出られない拠点へ git bundle を渡す。
 *
 * 相手は自分の HEAD (have) を添えて repo の main を求める。 こちらは catalog から repo の
 * checkout を探し、 `main` のうち相手が持っていない分だけを bundle にする (have を知らなければ全量)。
 * 相手の HEAD がこちらの main と同じなら渡すものは無い (up to date)。
 *
 * こちらの main は、 こちらの拠点で更新 / デプロイした時点のもの (origin から取り込み済み)。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Catalog } from '../../catalog/loader.js';
import { execCapture } from '../../shared/exec.js';
import { locateGitCheckout } from '../../scanner/git-fs.js';
import { repoDirOf } from '../../update/checker.js';

/** @implements SPEC-FEDERATION-MESH-SOURCE */

const GIT_TIMEOUT_MS = 5 * 60 * 1000;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const HASH_PATTERN = /^[0-9a-f]{7,64}$/;

export function isValidRepoName(repo: string): boolean {
  return REPO_PATTERN.test(repo);
}

export function isValidHash(hash: string): boolean {
  return HASH_PATTERN.test(hash);
}

/** catalog の `repo` が一致するサービスの checkout root (最初に見つかったもの)。 */
export async function findRepoCheckout(catalog: Pick<Catalog, 'services'>, repo: string): Promise<string | null> {
  const wanted = repo.toLowerCase();
  for (const svc of catalog.services) {
    if (svc.repo?.toLowerCase() !== wanted) continue;
    const dir = repoDirOf(svc);
    if (!dir) continue;
    const checkout = await locateGitCheckout(dir);
    if (checkout) return checkout.worktreeRoot;
  }
  return null;
}

export type BundleResult =
  | { kind: 'bundle'; path: string; cleanup: () => Promise<void> }
  | { kind: 'up_to_date' }
  | { kind: 'error'; status: 404 | 500; error: string };

/** bundle create の引数 (pure)。 have を持っていれば差分、 無ければ main 全量。 */
export function bundleCreateArgs(file: string, have: string | null): string[] {
  return ['bundle', 'create', file, 'refs/heads/main', ...(have ? [`^${have}`] : [])];
}

export async function createMainBundle(repoDir: string, have: string | null): Promise<BundleResult> {
  const main = await execCapture('git', ['rev-parse', '--verify', 'refs/heads/main'], repoDir, GIT_TIMEOUT_MS);
  if (!main.ok) return { kind: 'error', status: 404, error: 'this node has no local main branch for the repository' };
  const mainHash = main.stdout.trim();
  if (have && mainHash.startsWith(have)) return { kind: 'up_to_date' };

  // 相手の HEAD をこちらが持っていなければ差分は作れないので全量にする。
  const known = have
    ? (await execCapture('git', ['cat-file', '-e', `${have}^{commit}`], repoDir, GIT_TIMEOUT_MS)).ok
    : false;

  const dir = await mkdtemp(join(tmpdir(), 'excubitor-bundle-'));
  const file = join(dir, 'main.bundle');
  const cleanup = () => rm(dir, { recursive: true, force: true });
  const created = await execCapture('git', bundleCreateArgs(file, known ? have : null), repoDir, GIT_TIMEOUT_MS);
  if (!created.ok) {
    await cleanup();
    // 相手の HEAD が main より先にある (こちらの main が古い) と空 bundle になる。
    if (/empty bundle/i.test(created.stderr)) return { kind: 'up_to_date' };
    return { kind: 'error', status: 500, error: `git bundle create failed: ${created.stderr.trim().slice(-300)}` };
  }
  return { kind: 'bundle', path: file, cleanup };
}
