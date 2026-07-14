/**
 * component の repo から git メタ (branch / 短縮 commit / dirty) を取る。
 * VERSION.json に「どのコミットから焼いたか」を残すための監査情報。
 */

import { existsSync } from 'node:fs';
import { safeExec } from '../shared/exec.js';

export interface ComponentGitMeta {
  branch: string | null;
  commit: string | null;
  dirty: boolean;
}

export async function readGitMeta(repoDir: string): Promise<ComponentGitMeta> {
  if (!repoDir || !existsSync(`${repoDir}/.git`)) {
    return { branch: null, commit: null, dirty: false };
  }
  const branch = (await safeExec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repoDir))?.trim() || null;
  const commit = (await safeExec('git', ['rev-parse', '--short', 'HEAD'], repoDir))?.trim() || null;
  const status = await safeExec('git', ['status', '--porcelain'], repoDir);
  return { branch, commit, dirty: status !== null ? status.length > 0 : false };
}
