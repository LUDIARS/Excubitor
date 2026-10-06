/** @implements SPEC-EX-DAILY-SITE-DEPLOY */
import { lstat, readdir, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import type { Service } from '../../catalog/loader.js';
import { dailyCommand } from './command.js';

export interface DailyRepository { path: string; services: Service[] }
export function containsPath(root: string, child: string): boolean {
  const rel = relative(root, resolve(child));
  return rel === '' || (!rel.startsWith('..') && !rel.includes(':') && !rel.startsWith('/'));
}
export async function dailyRepositories(root: string, services: Service[], selfRoot: string): Promise<DailyRepository[]> {
  const folders = await readdir(root, { withFileTypes: true });
  const repositories: DailyRepository[] = [];
  for (const folder of folders) {
    if (!folder.isDirectory() || folder.isSymbolicLink() || folder.name.startsWith('.')) continue;
    const path = join(root, folder.name);
    const git = await lstat(join(path, '.git')).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!git?.isDirectory() || git.isSymbolicLink()) continue;
    const canonical = await realpath(path);
    repositories.push({ path: canonical, services: services.filter((svc) => {
      const cwd = svc.cwd ?? (svc.compose_file ? dirname(svc.compose_file) : null);
      return cwd !== null && containsPath(canonical, cwd);
    }) });
  }
  return repositories.sort((a, b) => Number(containsPath(a.path, selfRoot)) - Number(containsPath(b.path, selfRoot)) || a.path.localeCompare(b.path));
}
export async function assertCleanRepository(path: string): Promise<void> {
  if (await dailyCommand('git', ['status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=none'], path)) {
    throw new Error('local changes: skipped without overwriting');
  }
}
export async function prepareRepository(path: string): Promise<{ branch: string; before: string; after: string }> {
  await assertCleanRepository(path);
  const branch = await dailyCommand('git', ['symbolic-ref', '--short', 'HEAD'], path);
  const before = await dailyCommand('git', ['rev-parse', 'HEAD'], path);
  const remote = await dailyCommand('git', ['config', '--get', `branch.${branch}.remote`], path);
  if (!remote || remote === '.' || remote.startsWith('-')) throw new Error('no remote tracking branch');
  await dailyCommand('git', ['fetch', '--quiet', '--', remote], path, 180_000);
  const after = await dailyCommand('git', ['rev-parse', '@{upstream}'], path);
  try { await dailyCommand('git', ['merge-base', '--is-ancestor', before, after], path); }
  catch { throw new Error('Local commits are ahead of or diverged from upstream; skipped without overwriting'); }
  return { branch, before, after };
}
export async function assertExpectedRepository(path: string, branch: string, hashes: string[]): Promise<void> {
  if (await dailyCommand('git', ['symbolic-ref', '--short', 'HEAD'], path) !== branch) throw new Error('branch changed externally');
  if (!hashes.includes(await dailyCommand('git', ['rev-parse', 'HEAD'], path))) throw new Error('HEAD changed externally');
  // A crash between superproject merge and submodule update leaves expected pointer differences.
  // Ignore only those pointers, then independently reject edits inside every initialized submodule.
  if (await dailyCommand('git', ['status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=all'], path)) {
    throw new Error('local changes: recovery will not overwrite them');
  }
  await dailyCommand('git', ['submodule', 'foreach', '--quiet', '--recursive',
    'test -z "$(git status --porcelain --untracked-files=normal --ignore-submodules=all)"'], path);
}
