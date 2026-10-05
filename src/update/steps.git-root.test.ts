import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findGitRoot } from './steps.js';

const root = resolve('/ws');
const exists = (gitDirs: string[]) => (path: string) => gitDirs.some((d) => join(resolve(d), '.git') === path);

describe('findGitRoot', () => {
  it('finds the checkout root when cwd is a subdirectory (Cernere/server)', () => {
    expect(findGitRoot(join(root, 'Cernere', 'server'), exists([join(root, 'Cernere')]), root)).toBe(join(root, 'Cernere'));
  });

  it('returns cwd itself when it is the checkout root', () => {
    expect(findGitRoot(join(root, 'Aedilis'), exists([join(root, 'Aedilis')]), root)).toBe(join(root, 'Aedilis'));
  });

  it('never climbs into the workspace (Castra) checkout', () => {
    expect(findGitRoot(join(root, 'NoRepo', 'server'), exists([root]), root)).toBeNull();
  });

  it('stops after a bounded number of levels', () => {
    expect(findGitRoot(join(root, 'A', 'b', 'c', 'd'), exists([join(root, 'A')]), root)).toBeNull();
  });
});
