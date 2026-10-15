/**
 * 更新状態を調べる対象の checkout root を、 サービスの作業ディレクトリから決める。
 *
 * catalog の cwd が checkout のサブディレクトリ (例: Cernere/server) でも、 branch や差分は
 * checkout の root で読む (update / deploy の取り込みと同じ規則)。
 */

import { existsSync } from 'node:fs';
import { findGitRoot } from './git-root.js';

export type CheckoutRootNote = 'no_repo' | 'dir_missing' | 'not_git';

export type CheckoutRoot =
  | { repoDir: string; note: null }
  | { repoDir: string | null; note: CheckoutRootNote };

/** 作業ディレクトリ (null 可) から checkout root を解決する。 見つからない理由は note で返す。 */
export function resolveCheckoutRoot(
  workDir: string | null,
  exists: (path: string) => boolean = existsSync,
  workspaceRoot: string | undefined = process.env.EXCUBITOR_ARS_ROOT,
): CheckoutRoot {
  if (!workDir) return { repoDir: null, note: 'no_repo' };
  if (!exists(workDir)) return { repoDir: workDir, note: 'dir_missing' };
  const root = findGitRoot(workDir, exists, workspaceRoot);
  if (!root) return { repoDir: workDir, note: 'not_git' };
  return { repoDir: root, note: null };
}
