import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DIRTY_STATUS_ARGS } from './checker.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'protocol.file.allow=always', ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
    },
  });
}

// 実際の git で引数の意味を確かめる (フラグ名の打ち間違いや git の挙動差を拾う)。
describe('DIRTY_STATUS_ARGS', () => {
  let root: string;
  let parent: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'ex-dirty-'));
    const library = join(root, 'library');
    mkdirSync(library);
    git(library, 'init', '-q', '-b', 'main');
    git(library, 'config', 'core.fileMode', 'true');
    writeFileSync(join(library, 'cli.js'), '#!/usr/bin/env node\n');
    git(library, 'add', '.');
    git(library, 'commit', '-q', '-m', 'library');

    parent = join(root, 'parent');
    mkdirSync(parent);
    git(parent, 'init', '-q', '-b', 'main');
    git(parent, 'submodule', 'add', '-q', library, 'lib/library');
    git(parent, 'commit', '-q', '-m', 'add submodule');
  }, 120_000);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('ignores changes inside a submodule that plain status reports', () => {
    const inside = join(parent, 'lib', 'library');
    // npm install が bin に付ける実行権限と同じ種類の変化 (Windows では mode が無いので内容で代用)。
    chmodSync(join(inside, 'cli.js'), 0o755);
    writeFileSync(join(inside, 'cli.js'), '#!/usr/bin/env node\n// touched\n');

    expect(git(parent, 'status', '--porcelain')).toContain('lib/library');
    expect(git(parent, ...DIRTY_STATUS_ARGS).trim()).toBe('');

    git(inside, 'checkout', '--', 'cli.js');
  }, 120_000);

  it('still reports a submodule pointing at a different revision', () => {
    const inside = join(parent, 'lib', 'library');
    writeFileSync(join(inside, 'extra.js'), 'export {};\n');
    git(inside, 'add', '.');
    git(inside, 'commit', '-q', '-m', 'advance');

    expect(git(parent, ...DIRTY_STATUS_ARGS)).toContain('lib/library');
  }, 120_000);
});
