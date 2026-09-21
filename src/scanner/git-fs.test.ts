import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findPackedRef, locateGitCheckout, parseGitDirPointer, readGitHead } from './git-fs.js';

const HASH_A = 'a'.repeat(40);
const HASH_B = '0123456789abcdef0123456789abcdef01234567';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ex-git-fs-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function makeRepo(dir: string): string {
  const gitDir = join(dir, '.git');
  mkdirSync(join(gitDir, 'refs', 'heads'), { recursive: true });
  return gitDir;
}

describe('readGitHead', () => {
  it('reads the branch and a 12-char hash from a loose ref', async () => {
    const gitDir = makeRepo(root);
    write(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
    write(join(gitDir, 'refs', 'heads', 'main'), `${HASH_A}\n`);

    const checkout = await locateGitCheckout(root);
    expect(checkout?.worktreeRoot).toBe(root);
    await expect(readGitHead(checkout!)).resolves.toEqual({ branch: 'main', hash: HASH_A.slice(0, 12) });
  });

  it('falls back to packed-refs for branches with slashes', async () => {
    const gitDir = makeRepo(root);
    write(join(gitDir, 'HEAD'), 'ref: refs/heads/feat/mesh\n');
    write(join(gitDir, 'packed-refs'), `# pack-refs with: peeled fully-peeled sorted\n${HASH_B} refs/heads/feat/mesh\n^${HASH_A}\n`);

    const checkout = await locateGitCheckout(root);
    await expect(readGitHead(checkout!)).resolves.toEqual({ branch: 'feat/mesh', hash: HASH_B.slice(0, 12) });
  });

  it('reports detached HEAD like `git rev-parse --abbrev-ref HEAD`', async () => {
    const gitDir = makeRepo(root);
    write(join(gitDir, 'HEAD'), `${HASH_B}\n`);

    const checkout = await locateGitCheckout(root);
    await expect(readGitHead(checkout!)).resolves.toEqual({ branch: 'HEAD', hash: HASH_B.slice(0, 12) });
  });

  it('keeps the branch but no hash on an unborn branch', async () => {
    const gitDir = makeRepo(root);
    write(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');

    const checkout = await locateGitCheckout(root);
    await expect(readGitHead(checkout!)).resolves.toEqual({ branch: 'main', hash: null });
  });

  it('follows a worktree .git file and reads refs from the common dir', async () => {
    const mainGit = makeRepo(join(root, 'main'));
    write(join(mainGit, 'refs', 'heads', 'feature'), `${HASH_B}\n`);
    const wtGitDir = join(mainGit, 'worktrees', 'feature');
    write(join(wtGitDir, 'HEAD'), 'ref: refs/heads/feature\n');
    write(join(wtGitDir, 'commondir'), '../..\n');
    const worktree = join(root, 'wt');
    write(join(worktree, '.git'), `gitdir: ${wtGitDir}\n`);

    const checkout = await locateGitCheckout(join(worktree));
    expect(checkout).toMatchObject({ worktreeRoot: worktree, gitDir: wtGitDir, commonDir: mainGit });
    await expect(readGitHead(checkout!)).resolves.toEqual({ branch: 'feature', hash: HASH_B.slice(0, 12) });
  });

  it('walks up from a nested service directory to the checkout root', async () => {
    const gitDir = makeRepo(root);
    write(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
    write(join(gitDir, 'refs', 'heads', 'main'), `${HASH_A}\n`);
    const nested = join(root, 'build', 'bin');
    mkdirSync(nested, { recursive: true });

    const checkout = await locateGitCheckout(nested);
    expect(checkout?.worktreeRoot).toBe(root);
  });

  it('returns null when HEAD cannot be read', async () => {
    makeRepo(root);
    const checkout = await locateGitCheckout(root);
    await expect(readGitHead(checkout!)).resolves.toBeNull();
  });
});

describe('pure helpers', () => {
  it('finds an exact ref in packed-refs and ignores peeled lines', () => {
    const packed = `${HASH_A} refs/heads/main\n^${HASH_B}\n${HASH_B} refs/heads/main-2\n`;
    expect(findPackedRef(packed, 'refs/heads/main')).toBe(HASH_A);
    expect(findPackedRef(packed, 'refs/heads/missing')).toBeNull();
  });

  it('parses gitdir pointers', () => {
    expect(parseGitDirPointer('gitdir: ../.git/worktrees/x\n')).toBe('../.git/worktrees/x');
    expect(parseGitDirPointer('garbage')).toBeNull();
  });
});
