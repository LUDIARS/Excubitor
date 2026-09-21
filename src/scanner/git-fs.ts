/**
 * `.git` を直接読んで checkout の HEAD (branch / commit hash) を解決する。
 *
 * 監視ループは 90 前後のサービスについて毎回 git の現在地を読む。 以前は 1 サービスあたり
 * `git rev-parse` を 2 回起動しており (source git + disk version で倍)、 5 分ごとに数百の
 * 子プロセスを生んでいた。 HEAD と ref はただのファイルなので、 読むだけなら子プロセスは要らない。
 *
 * 対応する形:
 * - 通常の checkout (`<root>/.git/` がディレクトリ)
 * - worktree / submodule (`<root>/.git` が `gitdir: <path>` を書いたファイル。 ref は
 *   `commondir` が指す共有 git dir 側にある)
 * - loose ref (`refs/heads/<branch>`) と `packed-refs`
 * - detached HEAD (`git rev-parse --abbrev-ref HEAD` と同じく branch は `HEAD`)
 *
 * 読めない形 (reftable 等) は null を返し、 呼び出し側が git コマンドへ委ねる。
 */

import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/** @implements SPEC-MONITOR-LIGHTWEIGHT */

/** `git rev-parse --short=12` と同じ桁数。 service_instances.git_hash の既存値と揃える。 */
export const SHORT_HASH_LENGTH = 12;

export interface GitCheckout {
  /** 作業ツリーの root (`.git` を持つディレクトリ)。 repo 単位の重複排除キー。 */
  worktreeRoot: string;
  /** HEAD を持つ git dir (worktree なら `.git/worktrees/<name>`)。 */
  gitDir: string;
  /** refs / packed-refs を持つ共有 git dir。 */
  commonDir: string;
}

export interface GitHead {
  branch: string | null;
  hash: string | null;
}

const MAX_PARENT_WALK = 64;

/** cwd から親へ辿って最寄りの checkout を探す。 見つからなければ null。 */
export async function locateGitCheckout(cwd: string): Promise<GitCheckout | null> {
  let current = resolve(cwd);
  for (let depth = 0; depth < MAX_PARENT_WALK; depth += 1) {
    const dotGit = join(current, '.git');
    const kind = await pathKind(dotGit);
    if (kind === 'dir') {
      return { worktreeRoot: current, gitDir: dotGit, commonDir: await resolveCommonDir(dotGit) };
    }
    if (kind === 'file') {
      const gitDir = await readGitDirPointer(dotGit, current);
      if (!gitDir) return null;
      return { worktreeRoot: current, gitDir, commonDir: await resolveCommonDir(gitDir) };
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

/** checkout の HEAD を読む。 HEAD 自体が読めなければ null (= 呼び出し側で git コマンドへ)。 */
export async function readGitHead(checkout: GitCheckout): Promise<GitHead | null> {
  const head = await readTextOrNull(join(checkout.gitDir, 'HEAD'));
  if (head == null) return null;
  const trimmed = head.trim();
  const symbolic = /^ref:\s*(\S+)$/.exec(trimmed);
  if (!symbolic) {
    // detached HEAD: HEAD に hash が直接書かれている。
    return isFullHash(trimmed) ? { branch: 'HEAD', hash: shortHash(trimmed) } : null;
  }
  const ref = symbolic[1]!;
  const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
  const full = await resolveRef(checkout, ref);
  // unborn branch (コミット 0 件) は branch だけ返す。 rev-parse --short も失敗する状態なので hash は null。
  return { branch, hash: full ? shortHash(full) : null };
}

async function resolveRef(checkout: GitCheckout, ref: string): Promise<string | null> {
  // worktree 固有の ref (refs/bisect 等) は gitDir、 branch は commonDir にある。 両方見る。
  for (const dir of uniqueDirs(checkout.gitDir, checkout.commonDir)) {
    const loose = await readTextOrNull(join(dir, ref));
    if (loose != null && isFullHash(loose.trim())) return loose.trim();
  }
  const packed = await readTextOrNull(join(checkout.commonDir, 'packed-refs'));
  return packed == null ? null : findPackedRef(packed, ref);
}

/** packed-refs 本文から ref の hash を引く (pure)。 */
export function findPackedRef(packed: string, ref: string): string | null {
  for (const line of packed.split(/\r?\n/)) {
    if (!line || line.startsWith('#') || line.startsWith('^')) continue;
    const space = line.indexOf(' ');
    if (space <= 0) continue;
    if (line.slice(space + 1).trim() === ref) {
      const hash = line.slice(0, space);
      return isFullHash(hash) ? hash : null;
    }
  }
  return null;
}

/** `.git` ファイルの `gitdir: <path>` を絶対パスへ解決する (pure 部分は parseGitDirPointer)。 */
async function readGitDirPointer(dotGitFile: string, worktreeRoot: string): Promise<string | null> {
  const text = await readTextOrNull(dotGitFile);
  if (text == null) return null;
  const pointer = parseGitDirPointer(text);
  if (!pointer) return null;
  return isAbsolute(pointer) ? pointer : resolve(worktreeRoot, pointer);
}

export function parseGitDirPointer(text: string): string | null {
  const match = /^gitdir:\s*(.+)$/m.exec(text);
  return match ? match[1]!.trim() : null;
}

async function resolveCommonDir(gitDir: string): Promise<string> {
  const text = await readTextOrNull(join(gitDir, 'commondir'));
  if (text == null || !text.trim()) return gitDir;
  const pointer = text.trim();
  return isAbsolute(pointer) ? pointer : resolve(gitDir, pointer);
}

function shortHash(full: string): string {
  return full.slice(0, SHORT_HASH_LENGTH);
}

function isFullHash(value: string): boolean {
  // SHA-1 (40) と SHA-256 (64) の両 object format を受ける。
  return /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(value);
}

function uniqueDirs(...dirs: string[]): string[] {
  return [...new Set(dirs)];
}

async function pathKind(path: string): Promise<'dir' | 'file' | null> {
  try {
    const s = await stat(path);
    if (s.isDirectory()) return 'dir';
    if (s.isFile()) return 'file';
    return null;
  } catch {
    // 存在しない (ENOENT) / 権限なし: どちらも「ここは checkout ではない」として親へ進む。
    return null;
  }
}

async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    // ref が loose で存在しない等は正常系 (packed-refs 側にある)。 null で次の候補へ。
    return null;
  }
}
