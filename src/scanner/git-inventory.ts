/**
 * inventory 走査 1 回分の git 情報読み取りを共有する。
 *
 * 同じリポジトリを cwd に持つサービスは多い (1 リポに backend / worker / app が並ぶ)。
 * 走査のたびにサービス単位で `git status` を起動すると同じ working tree を何度も舐めるので、
 * checkout の root 単位で 1 回だけ読み、 同じ走査中の他のサービスはその結果を使う。
 *
 * 寿命は 1 走査。 走査をまたいで保持しない (次の走査では branch 切替や編集を読み直す)。
 */

import { locateGitCheckout, type GitCheckout, type GitHead } from './git-fs.js';
import { readGitDirty, readHead, readPackageVersion, type GitInfoReader } from './git.js';

/** @implements SPEC-MONITOR-LIGHTWEIGHT */

export interface GitInventoryDeps {
  locate?: (cwd: string) => Promise<GitCheckout | null>;
  head?: (checkout: GitCheckout | null, cwd: string) => Promise<GitHead>;
  dirty?: (cwd: string) => Promise<boolean | null>;
  packageVersion?: (cwd: string) => Promise<string | null>;
}

export interface GitInventory {
  read: GitInfoReader;
  /** この走査で実際に `git status` を起動した checkout の数 (ログ / テスト用)。 */
  dirtyChecks: () => number;
}

export function createGitInventory(deps: GitInventoryDeps = {}): GitInventory {
  const locate = deps.locate ?? locateGitCheckout;
  const head = deps.head ?? readHead;
  const dirty = deps.dirty ?? readGitDirty;
  const packageVersion = deps.packageVersion ?? readPackageVersion;

  const checkoutByCwd = new Map<string, Promise<GitCheckout | null>>();
  const headByRoot = new Map<string, Promise<GitHead>>();
  const dirtyByRoot = new Map<string, Promise<boolean | null>>();
  const versionByCwd = new Map<string, Promise<string | null>>();

  const memo = <T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> => {
    const hit = cache.get(key);
    if (hit) return hit;
    const pending = load();
    cache.set(key, pending);
    return pending;
  };

  const read: GitInfoReader = async (cwd) => {
    const checkout = await memo(checkoutByCwd, cwd, () => locate(cwd));
    // checkout が見つからない cwd は git コマンド側に判定を任せる (key は cwd のまま)。
    const rootKey = checkout?.worktreeRoot ?? `cwd:${cwd}`;
    const dirtyCwd = checkout?.worktreeRoot ?? cwd;
    const [h, d, v] = await Promise.all([
      memo(headByRoot, rootKey, () => head(checkout, cwd)),
      memo(dirtyByRoot, rootKey, () => dirty(dirtyCwd)),
      memo(versionByCwd, cwd, () => packageVersion(cwd)),
    ]);
    return { branch: h.branch, hash: h.hash, dirty: d, package_version: v };
  };

  return { read, dirtyChecks: () => dirtyByRoot.size };
}
