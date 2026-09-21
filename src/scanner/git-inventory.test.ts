import { describe, expect, it, vi } from 'vitest';
import { createGitInventory } from './git-inventory.js';
import type { GitCheckout } from './git-fs.js';

function checkoutAt(root: string): GitCheckout {
  return { worktreeRoot: root, gitDir: `${root}/.git`, commonDir: `${root}/.git` };
}

describe('createGitInventory', () => {
  it('runs git status once per checkout even when several services share it', async () => {
    const dirty = vi.fn(async () => true);
    const head = vi.fn(async () => ({ branch: 'main', hash: 'abcdef123456' }));
    const inventory = createGitInventory({
      locate: async (cwd) => checkoutAt(cwd.startsWith('/repo-a') ? '/repo-a' : '/repo-b'),
      head,
      dirty,
      packageVersion: async (cwd) => (cwd === '/repo-a/backend' ? '1.0.0' : null),
    });

    const [backend, worker, other] = await Promise.all([
      inventory.read('/repo-a/backend'),
      inventory.read('/repo-a/worker'),
      inventory.read('/repo-b'),
    ]);

    expect(backend).toEqual({ branch: 'main', hash: 'abcdef123456', dirty: true, package_version: '1.0.0' });
    expect(worker.package_version).toBeNull();
    expect(other.dirty).toBe(true);
    expect(dirty).toHaveBeenCalledTimes(2);
    expect(dirty).toHaveBeenCalledWith('/repo-a');
    expect(head).toHaveBeenCalledTimes(2);
    expect(inventory.dirtyChecks()).toBe(2);
  });

  it('lets the git command decide for a directory outside any checkout', async () => {
    const head = vi.fn(async () => ({ branch: null, hash: null }));
    const dirty = vi.fn(async () => null);
    const inventory = createGitInventory({
      locate: async () => null,
      head,
      dirty,
      packageVersion: async () => null,
    });

    await expect(inventory.read('/not-a-repo')).resolves.toEqual({
      branch: null, hash: null, dirty: null, package_version: null,
    });
    expect(head).toHaveBeenCalledWith(null, '/not-a-repo');
    expect(dirty).toHaveBeenCalledWith('/not-a-repo');
  });
});
