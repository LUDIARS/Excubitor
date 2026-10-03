import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnEnvFor } from './exec.js';

describe('spawnEnvFor', () => {
  it('turns off git optional locks for git in any spelling', () => {
    for (const cmd of ['git', 'git.exe', 'GIT.EXE', 'C:\\Program Files\\Git\\cmd\\git.exe', '/usr/bin/git']) {
      expect(spawnEnvFor(cmd).GIT_OPTIONAL_LOCKS).toBe('0');
    }
  });

  it('leaves other commands untouched', () => {
    for (const cmd of ['npm', 'node', 'gitleaks', 'taskkill']) {
      expect(spawnEnvFor(cmd).GIT_OPTIONAL_LOCKS).toBe(process.env.GIT_OPTIONAL_LOCKS);
    }
  });
});

// 実際の git で、 この env の status が index を書き戻さない (= index.lock を取らない) ことを確かめる。
describe('git status with the spawn env', () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'ex-git-locks-'));
    const git = (...args: string[]) => execFileSync('git', args, {
      cwd: repo,
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' },
    });
    git('init', '-q');
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    // stat 情報を古くして、 通常の status なら index を書き戻す状態にする。
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(repo, 'a.txt'), past, past);
  }, 120_000);

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('does not rewrite the index (so a kill cannot leave index.lock behind)', () => {
    const index = join(repo, '.git', 'index');
    expect(existsSync(index)).toBe(true);
    const mtimeBefore = statSync(index).mtimeMs;
    execFileSync('git', ['status', '--porcelain'], { cwd: repo, env: spawnEnvFor('git') });
    expect(statSync(index).mtimeMs).toBe(mtimeBefore);
    expect(existsSync(join(repo, '.git', 'index.lock'))).toBe(false);
  }, 120_000);
});
