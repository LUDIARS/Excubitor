import { describe, it, expect } from 'vitest';
import { parseBranchList } from './checker.js';

describe('parseBranchList', () => {
  it('ローカル + リモート (origin) を統合し current フラグを立てる', () => {
    const local = 'main\nfeat/foo\nfix/bar';
    const remote = 'origin/main\norigin/feat/foo\norigin/HEAD -> origin/main';
    const branches = parseBranchList(local, remote, 'feat/foo');
    expect(branches).toEqual([
      { name: 'main', current: false, remote: false },
      { name: 'feat/foo', current: true, remote: false },
      { name: 'fix/bar', current: false, remote: false },
      { name: 'origin/main', current: false, remote: true },
      { name: 'origin/feat/foo', current: false, remote: true },
    ]);
  });

  it('detached HEAD 行は除外', () => {
    const branches = parseBranchList('(HEAD detached at abc123)\nmain', '', null);
    expect(branches).toEqual([{ name: 'main', current: false, remote: false }]);
  });

  it('空入力は空配列', () => {
    expect(parseBranchList('', '', null)).toEqual([]);
  });
});
