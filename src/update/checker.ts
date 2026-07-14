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

export interface CommitInfo {
  hash: string;
  subject: string;
  author: string;
  /** ISO8601 (commit date)。 */
  date: string;
  /** 相対表現 (例 "2 hours ago")。 */
  relative: string;
}

/**
 * サービスのリポジトリの最近のコミットを取得する (カード「最近の更新内容」用)。
 * `git log` を機械可読フォーマットで読む。 取得不能 (no_repo 等) は空配列。
 */
export async function recentCommits(svc: Service, limit = 5): Promise<CommitInfo[]> {
  const repoDir = repoDirOf(svc);
  if (!repoDir || !existsSync(repoDir) || !existsSync(`${repoDir}/.git`)) return [];
  // 区切りは制御文字 (US=\x1f 行内, RS=\x1e 行間) でメッセージ内の改行/記号と衝突させない。
  const fmt = '%h\x1f%s\x1f%an\x1f%cI\x1f%cr\x1e';
  const out = await safeExec(
    'git',
    ['log', `-n`, String(Math.max(1, Math.min(50, limit))), `--pretty=format:${fmt}`],
    repoDir,
  );
  if (!out) return [];
  const commits: CommitInfo[] = [];
  for (const rec of out.split('\x1e')) {
    const r = rec.replace(/^\s+/, '');
    if (!r) continue;
    const [hash, subject, author, date, relative] = r.split('\x1f');
    if (!hash) continue;
    commits.push({
      hash,
      subject: subject ?? '',
      author: author ?? '',
      date: date ?? '',
      relative: relative ?? '',
    });
  }
  return commits;
}

export interface BranchInfo {
  name: string;
  current: boolean;
  /** リモート追跡ブランチか (refs/remotes/origin/...)。 */
  remote: boolean;
}

export interface BranchStatus {
  code: string;
  repoDir: string | null;
  current: string | null;
  dirty: boolean;
  ahead: number;
  behind: number;
  /** ローカル + リモート (origin) のブランチ一覧。 */
  branches: BranchInfo[];
  note: string | null;
}

/** `git branch` の機械可読出力をパースする (pure)。 行頭 '*' が current。 */
export function parseBranchList(localRaw: string, remoteRaw: string, current: string | null): BranchInfo[] {
  const out: BranchInfo[] = [];
  for (const line of localRaw.split(/\r?\n/)) {
    const name = line.replace(/^\*?\s+/, '').trim();
    if (!name || name.startsWith('(')) continue; // detached HEAD 行 "(HEAD detached...)" は除外
    out.push({ name, current: name === current, remote: false });
  }
  for (const line of remoteRaw.split(/\r?\n/)) {
    const name = line.trim();
    if (!name || name.includes('->')) continue; // "origin/HEAD -> origin/main" は除外
    out.push({ name, current: false, remote: true });
  }
  return out;
}

/**
 * 1 サービスのブランチ状況 (現在ブランチ / ローカル+リモート一覧 / ahead-behind / dirty)。
 * fetch はしない (最新の remote 反映が要るときは先に update の fetch を回す)。
 */
export async function branchStatus(svc: Service): Promise<BranchStatus> {
  const repoDir = repoDirOf(svc);
  const base: BranchStatus = {
    code: svc.code, repoDir, current: null, dirty: false, ahead: 0, behind: 0, branches: [], note: null,
  };
  if (!repoDir) return { ...base, note: 'no_repo' };
  if (!existsSync(repoDir)) return { ...base, note: 'dir_missing' };
  if (!existsSync(`${repoDir}/.git`)) return { ...base, note: 'not_git' };

  const status = await checkUpdate(svc, false);
  const [localRaw, remoteRaw] = await Promise.all([
    safeExec('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], repoDir),
    safeExec('git', ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin'], repoDir),
  ]);
  const branches = parseBranchList(localRaw ?? '', remoteRaw ?? '', status.branch);
  return {
    code: svc.code,
    repoDir,
    current: status.branch,
    dirty: status.dirty,
    ahead: status.ahead,
    behind: status.behind,
    branches,
    note: status.note,
  };
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
