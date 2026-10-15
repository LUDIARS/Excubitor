/**
 * サービスの cwd を含む git checkout の root を探す。
 *
 * update / deploy の git 取り込みと更新状態の確認が同じ規則で root を決めるための共通関数。
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** cwd から git root を探す段数。 これより上はワークスペース (Castra) の checkout になりうる。 */
const GIT_ROOT_MAX_DEPTH = 2;

/**
 * サービスの cwd を含む git checkout の root を返す。 cwd が repo のサブディレクトリ
 * (例: Cernere/server) でも取り込めるようにする。 ワークスペース root (EXCUBITOR_ARS_ROOT) は
 * 別リポの checkout なので採らない。
 */
export function findGitRoot(
  dir: string,
  exists: (path: string) => boolean = existsSync,
  workspaceRoot: string | undefined = process.env.EXCUBITOR_ARS_ROOT,
): string | null {
  const stop = workspaceRoot ? resolve(workspaceRoot) : null;
  let current = resolve(dir);
  for (let depth = 0; depth <= GIT_ROOT_MAX_DEPTH; depth++) {
    if (stop && current === stop) return null;
    if (exists(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}
