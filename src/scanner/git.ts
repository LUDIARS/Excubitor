import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { killProcessTree } from '../shared/kill-tree.js';
import { locateGitCheckout, readGitHead, type GitCheckout, type GitHead } from './git-fs.js';

export interface GitInfo {
  branch: string | null;
  hash: string | null;
  dirty: boolean | null;
  package_version: string | null;
}

/** cwd の GitInfo を返す読み手。 inventory 走査では repo 単位で共有する実装 (git-inventory.ts) を渡す。 */
export type GitInfoReader = (cwd: string) => Promise<GitInfo>;

const GIT_TIMEOUT_MS = 5000;

/**
 * catalog.cwd の git/package 情報を取得する。
 * - branch / hash は `.git` を直接読む (子プロセス無し、 scanner/git-fs.ts)。
 *   読めない形式のときだけ git コマンドへ委ねる。
 * - dirty は working tree の走査が要るので `git status --porcelain` を 1 回だけ起動する。
 * - 取得失敗 (cwd 無い / git 無い) は null を返す。
 */
export async function readGitInfo(cwd: string): Promise<GitInfo> {
  const checkout = await locateGitCheckout(cwd);
  const [head, dirty, version] = await Promise.all([
    readHead(checkout, cwd),
    readGitDirty(cwd),
    readPackageVersion(cwd),
  ]);
  return { branch: head.branch, hash: head.hash, dirty, package_version: version };
}

/** HEAD を読む。 `.git` から読めなければ git コマンドで解決する (reftable 等の非対応形式)。 */
export async function readHead(checkout: GitCheckout | null, cwd: string): Promise<GitHead> {
  if (checkout) {
    const head = await readGitHead(checkout);
    if (head) return head;
  }
  const [branch, hash] = await Promise.all([
    safeExec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
    safeExec('git', ['rev-parse', '--short=12', 'HEAD'], cwd),
  ]);
  return { branch: branch?.trim() || null, hash: hash?.trim() || null };
}

/** working tree に未コミット変更 (untracked 含む) があるか。 git が使えなければ null。 */
export async function readGitDirty(cwd: string): Promise<boolean | null> {
  const out = await safeExec('git', ['status', '--porcelain'], cwd);
  return out !== null ? out.length > 0 : null;
}

export async function readPackageVersion(cwd: string): Promise<string | null> {
  try {
    const raw = await readFile(resolve(cwd, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? null;
  } catch {
    // package.json を持たないリポ (Unity / C++ 等) は正常系。 版は git hash 側で表す。
    return null;
  }
}

function safeExec(cmd: string, args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolveP) => {
    const proc = spawn(cmd, args, { cwd, shell: false, windowsHide: true });
    let stdout = '';
    const timeout = setTimeout(() => {
      killProcessTree(proc);
      resolveP(null);
    }, GIT_TIMEOUT_MS);
    proc.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    proc.on('error', () => { clearTimeout(timeout); resolveP(null); });
    proc.on('close', (code) => {
      clearTimeout(timeout);
      resolveP(code === 0 ? stdout : null);
    });
  });
}
