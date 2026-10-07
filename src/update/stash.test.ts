import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stashWorkingTree } from './stash.js';

const exec = promisify(execFile);
const roots: string[] = [];
const TEST_TIMEOUT_MS = 60_000;
async function git(root: string, ...args: string[]): Promise<string> {
  return (await exec('git', args, { cwd: root, windowsHide: true, timeout: 15_000, encoding: 'utf8' })).stdout.trim();
}
async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'excubitor-stash-'));
  roots.push(root);
  await git(root, 'init', '--initial-branch=main');
  await git(root, 'config', 'user.name', 'Stash fixture');
  await git(root, 'config', 'user.email', 'stash@example.invalid');
  await git(root, 'config', 'core.autocrlf', 'false');
  await writeFile(join(root, '.gitignore'), 'ignored.txt\n');
  await writeFile(join(root, 'tracked.txt'), 'original\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'fixture');
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const absolute = resolve(root);
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !absolute.includes('excubitor-stash-')) throw new Error('Unsafe fixture cleanup path');
    await rm(absolute, { recursive: true, force: true });
  }
});

describe('explicit repository stash', () => {
  it('preserves staged, unstaged and untracked changes in a restorable stash while leaving ignored files and HEAD alone', async () => {
    const root = await repository();
    const head = await git(root, 'rev-parse', 'HEAD');
    await writeFile(join(root, 'tracked.txt'), 'staged\n');
    await git(root, 'add', 'tracked.txt');
    await writeFile(join(root, 'tracked.txt'), 'unstaged\n');
    await writeFile(join(root, 'untracked.txt'), 'untracked\n');
    await writeFile(join(root, 'ignored.txt'), 'ignored\n');
    const steps = await stashWorkingTree(root, 'op-stash');
    expect(steps.every(step => step.ok)).toBe(true);
    const hash = await git(root, 'rev-parse', 'refs/stash');
    expect(steps[0]?.detail).toContain(hash);
    expect(await git(root, 'status', '--porcelain')).toBe('');
    expect(await git(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(await readFile(join(root, 'ignored.txt'), 'utf8')).toBe('ignored\n');
    await git(root, 'stash', 'apply', '--index', hash);
    expect(await git(root, 'show', ':tracked.txt')).toBe('staged');
    expect(await readFile(join(root, 'tracked.txt'), 'utf8')).toBe('unstaged\n');
    expect(await readFile(join(root, 'untracked.txt'), 'utf8')).toBe('untracked\n');
    expect(await git(root, 'rev-parse', 'refs/stash')).toBe(hash);
  }, TEST_TIMEOUT_MS);

  it('does not create a stash for a clean checkout', async () => {
    const root = await repository();
    expect(await stashWorkingTree(root, 'op-clean')).toEqual([{ step: 'stash', ok: true, detail: '退避する変更はありません' }]);
    await expect(git(root, 'rev-parse', '--verify', 'refs/stash')).rejects.toThrow();
  }, TEST_TIMEOUT_MS);

  it('refuses an in-progress merge without moving the users changes', async () => {
    const root = await repository();
    await writeFile(join(root, 'tracked.txt'), 'pending\n');
    await writeFile(join(root, '.git', 'MERGE_HEAD'), await git(root, 'rev-parse', 'HEAD'));
    expect(await stashWorkingTree(root, 'op-merge')).toEqual([expect.objectContaining({ ok: false, detail: expect.stringContaining('途中') })]);
    expect(await readFile(join(root, 'tracked.txt'), 'utf8')).toBe('pending\n');
  }, TEST_TIMEOUT_MS);

  it('resolves a catalog subdirectory to its primary repository', async () => {
    const root = await repository();
    await mkdir(join(root, 'server'));
    await writeFile(join(root, 'tracked.txt'), 'pending\n');
    expect((await stashWorkingTree(join(root, 'server'), 'op-subdir')).every(step => step.ok)).toBe(true);
    expect(await git(root, 'status', '--porcelain')).toBe('');
  }, TEST_TIMEOUT_MS);

  it('retains a receipt if Git saved the stash but failed to clean the working tree, without leaking command output', async () => {
    const root = await repository();
    const hash = 'a'.repeat(40);
    const run = vi.fn()
      .mockResolvedValueOnce({ ok: true, code: 0, stdout: 'main', stderr: '' })
      .mockResolvedValueOnce({ ok: true, code: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ ok: true, code: 0, stdout: ' M tracked.txt\0', stderr: '' })
      .mockResolvedValueOnce({ ok: false, code: 1, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ ok: false, code: 1, stdout: 'private user data', stderr: 'private error' })
      .mockResolvedValueOnce({ ok: true, code: 0, stdout: hash, stderr: '' })
      .mockResolvedValueOnce({ ok: true, code: 0, stdout: 'On main: Excubitor operation op-partial', stderr: '' });
    const steps = await stashWorkingTree(root, 'op-partial', run);
    expect(steps[0]).toMatchObject({ ok: false, detail: expect.stringContaining(hash) });
    expect(JSON.stringify(steps)).not.toContain('private');
    expect(run.mock.calls.filter(([args]) => args[0] === 'stash')).toHaveLength(1);
  }, TEST_TIMEOUT_MS);
});
