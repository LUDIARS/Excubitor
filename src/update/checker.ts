/**
 * サービス (= git リポジトリ) のアップデート確認。
 *
 * 各サービスの作業ディレクトリ (node=cwd / docker-compose=compose_file の親) で
 * git の HEAD と origin/<branch> を比較し、 behind (未取得コミット数) を出す。
 * behind > 0 ならアップデートあり。 fetch は任意 (一覧表示では省略して高速化)。
 */

import { dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { createNamedLogger } from '../shared/logger.js';
import { safeExec } from '../shared/exec.js';
import type { Service, Catalog } from '../catalog/loader.js';

const logger = createNamedLogger('excubitor.update');

export interface UpdateStatus {
  code: string;
  repoDir: string | null;
  branch: string | null;
  /** origin/<branch> にあって手元に無いコミット数 (= 取り込めるアップデート)。 */
  behind: number;
  /** 手元にあって origin に無いコミット数 (未 push)。 */
  ahead: number;
  dirty: boolean;
  /** behind > 0。 */
  available: boolean;
  /** 確認できなかった理由 (no_repo / not_git / fetch_failed 等)。 */
  note: string | null;
  fetched: boolean;
}

/** サービスの git リポジトリディレクトリ。 node=cwd、 docker-compose=compose_file の親。 */
export function repoDirOf(svc: Service): string | null {
  if (svc.cwd) return svc.cwd;
  if (svc.compose_file) return dirname(svc.compose_file);
  return null;
}

function empty(code: string, repoDir: string | null, note: string): UpdateStatus {
  return { code, repoDir, branch: null, behind: 0, ahead: 0, dirty: false, available: false, note, fetched: false };
}

/** 1 サービスのアップデート状態を取る。 fetch=true で origin を取りに行く (遅い)。 */
export async function checkUpdate(svc: Service, fetch = false): Promise<UpdateStatus> {
  const repoDir = repoDirOf(svc);
  if (!repoDir) return empty(svc.code, null, 'no_repo');
  if (!existsSync(repoDir)) return empty(svc.code, repoDir, 'dir_missing');
  if (!existsSync(`${repoDir}/.git`)) return empty(svc.code, repoDir, 'not_git');

  const branchRaw = await safeExec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repoDir);
  const branch = branchRaw?.trim() || null;
  if (!branch) return empty(svc.code, repoDir, 'no_branch');

  let fetched = false;
  let note: string | null = null;
  if (fetch) {
    const f = await safeExec('git', ['fetch', '--quiet', 'origin', branch], repoDir, 30000);
    fetched = f !== null;
    if (!fetched) note = 'fetch_failed';
  }

  const dirtyRaw = await safeExec('git', ['status', '--porcelain'], repoDir);
  const dirty = dirtyRaw !== null ? dirtyRaw.length > 0 : false;

  // origin/<branch> が無い (未 push branch 等) 場合は behind=0 扱い。
  const counts = await safeExec(
    'git',
    ['rev-list', '--left-right', '--count', `HEAD...origin/${branch}`],
    repoDir,
  );
  let behind = 0;
  let ahead = 0;
  if (counts) {
    const parts = counts.trim().split(/\s+/);
    const a = parseInt(parts[0] ?? '', 10);
    const b = parseInt(parts[1] ?? '', 10);
    ahead = Number.isFinite(a) ? a : 0;
    behind = Number.isFinite(b) ? b : 0;
  } else if (!note) {
    note = 'no_upstream';
  }

  return { code: svc.code, repoDir, branch, behind, ahead, dirty, available: behind > 0, note, fetched };
}

/** catalog 全サービスを並列 (上限あり) で確認する。 repoDir 重複は 1 回に集約。 */
export async function checkAllUpdates(catalog: Catalog, fetch = false): Promise<UpdateStatus[]> {
  // 同一 repoDir を共有する複数サービス (backend/frontend 等) は 1 回だけ確認して使い回す。
  const byRepo = new Map<string, UpdateStatus>();
  const results: UpdateStatus[] = [];
  const queue = [...catalog.services];
  const CONCURRENCY = 6;

  async function worker(): Promise<void> {
    for (;;) {
      const svc = queue.shift();
      if (!svc) return;
      const repoDir = repoDirOf(svc);
      if (repoDir && byRepo.has(repoDir)) {
        results.push({ ...byRepo.get(repoDir)!, code: svc.code });
        continue;
      }
      const status = await checkUpdate(svc, fetch);
      if (repoDir) byRepo.set(repoDir, status);
      results.push(status);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  logger.info({ count: results.length, available: results.filter((r) => r.available).length, fetch }, 'checked updates');
  // catalog 順に整列し直す。
  const order = new Map(catalog.services.map((s, i) => [s.code, i]));
  return results.sort((a, b) => (order.get(a.code) ?? 0) - (order.get(b.code) ?? 0));
}
