import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveCheckoutRoot } from './checkout-root.js';

const root = resolve('/ws');
const fs = (dirs: string[], gitDirs: string[]) => (path: string) =>
  dirs.some((d) => resolve(d) === resolve(path)) || gitDirs.some((d) => join(resolve(d), '.git') === path);

describe('resolveCheckoutRoot', () => {
  it('reads the checkout root when cwd is a subdirectory (Cernere/server)', () => {
    const workDir = join(root, 'Cernere', 'server');
    expect(resolveCheckoutRoot(workDir, fs([workDir], [join(root, 'Cernere')]), root))
      .toEqual({ repoDir: join(root, 'Cernere'), note: null });
  });

  it('uses cwd itself when it is the checkout root', () => {
    const workDir = join(root, 'Aedilis');
    expect(resolveCheckoutRoot(workDir, fs([workDir], [workDir]), root)).toEqual({ repoDir: workDir, note: null });
  });

  it('reports no_repo when the service has no working directory', () => {
    expect(resolveCheckoutRoot(null, fs([], []), root)).toEqual({ repoDir: null, note: 'no_repo' });
  });

  it('reports dir_missing when the working directory does not exist', () => {
    const workDir = join(root, 'Gone');
    expect(resolveCheckoutRoot(workDir, fs([], []), root)).toEqual({ repoDir: workDir, note: 'dir_missing' });
  });

  it('reports not_git without climbing into the workspace checkout', () => {
    const workDir = join(root, 'NoRepo', 'server');
    expect(resolveCheckoutRoot(workDir, fs([workDir], [root]), root)).toEqual({ repoDir: workDir, note: 'not_git' });
  });
});
