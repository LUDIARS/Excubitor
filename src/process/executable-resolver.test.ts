import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveExecutable } from './executable-resolver.js';

const temporaryDirs: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ex-resolve-'));
  temporaryDirs.push(dir);
  return dir;
}

function touch(dir: string, name: string): string {
  const path = join(dir, name);
  writeFileSync(path, '', 'utf8');
  return path;
}

afterEach(() => {
  while (temporaryDirs.length > 0) rmSync(temporaryDirs.pop()!, { recursive: true, force: true });
});

const WIN = { platform: 'win32' as NodeJS.Platform };

describe('resolveExecutable', () => {
  it('resolves a bare name to the .exe on PATH and drops the shell', () => {
    // cmd.exe を挟まないので、返り pid が実サービスのものになり detached も付けられる。
    const dir = workspace();
    const exe = touch(dir, 'node.exe');

    expect(
      resolveExecutable('node', { ...WIN, cwd: workspace(), env: { PATH: dir, PATHEXT: '.EXE;.CMD' } }),
    ).toEqual({ command: exe, shell: false });
  });

  it('keeps the shell for a .cmd entry because only cmd.exe can start it', () => {
    const dir = workspace();
    touch(dir, 'npm.cmd');

    expect(
      resolveExecutable('npm', { ...WIN, cwd: workspace(), env: { PATH: dir, PATHEXT: '.EXE;.CMD' } }),
    ).toEqual({ command: 'npm', shell: true });
  });

  it('prefers the earlier PATHEXT entry', () => {
    const dir = workspace();
    const exe = touch(dir, 'tool.exe');
    touch(dir, 'tool.cmd');

    expect(
      resolveExecutable('tool', { ...WIN, cwd: workspace(), env: { PATH: dir, PATHEXT: '.EXE;.CMD' } }),
    ).toEqual({ command: exe, shell: false });
  });

  it('honours an explicit extension without trying PATHEXT', () => {
    const dir = workspace();
    touch(dir, 'start-service.bat');

    expect(
      resolveExecutable('start-service.bat', {
        ...WIN,
        cwd: workspace(),
        env: { PATH: dir, PATHEXT: '.EXE;.CMD' },
      }),
    ).toEqual({ command: 'start-service.bat', shell: true });
  });

  it('does not replace a batch token with an unquoted absolute path containing spaces', () => {
    const root = workspace();
    const bin = join(root, 'Program Files', 'nodejs');
    mkdirSync(bin, { recursive: true });
    touch(bin, 'npm.cmd');

    expect(
      resolveExecutable('npm', { ...WIN, cwd: workspace(), env: { PATH: bin, PATHEXT: '.CMD' } }),
    ).toEqual({ command: 'npm', shell: true });
  });

  it('resolves an absolute path as given', () => {
    const dir = workspace();
    const exe = touch(dir, 'service.exe');

    expect(resolveExecutable(exe, { ...WIN, cwd: workspace(), env: { PATH: '', PATHEXT: '.EXE' } }))
      .toEqual({ command: exe, shell: false });
  });

  it('searches the working directory before PATH', () => {
    const cwd = workspace();
    const other = workspace();
    const local = touch(cwd, 'tool.exe');
    touch(other, 'tool.exe');

    expect(resolveExecutable('tool', { ...WIN, cwd, env: { PATH: other, PATHEXT: '.EXE' } }))
      .toEqual({ command: local, shell: false });
  });

  it('ignores a directory that has an executable-looking name', () => {
    const cwd = workspace();
    const bin = workspace();
    mkdirSync(join(cwd, 'node.exe'));
    const executable = touch(bin, 'node.exe');

    expect(resolveExecutable('node', { ...WIN, cwd, env: { PATH: bin, PATHEXT: '.EXE' } }))
      .toEqual({ command: executable, shell: false });
  });

  it('accepts quoted PATH entries and returns an absolute path', () => {
    const cwd = workspace();
    const bin = workspace();
    const executable = touch(bin, 'node.exe');

    expect(resolveExecutable('node', { ...WIN, cwd, env: { PATH: `"${bin}"`, PATHEXT: '.EXE' } }))
      .toEqual({ command: executable, shell: false });
  });

  it('falls back to the shell when nothing resolves', () => {
    // ここで throw すると、これまで起動できていた入口を落としてしまう。
    expect(
      resolveExecutable('mystery', { ...WIN, cwd: workspace(), env: { PATH: '', PATHEXT: '.EXE' } }),
    ).toEqual({ command: 'mystery', shell: true });
  });

  it('reads PATH and PATHEXT regardless of case', () => {
    const dir = workspace();
    const exe = touch(dir, 'node.exe');

    expect(resolveExecutable('node', { ...WIN, cwd: workspace(), env: { Path: dir, PathExt: '.EXE' } }))
      .toEqual({ command: exe, shell: false });
  });

  it('never asks for a shell off win32', () => {
    expect(resolveExecutable('npm', { platform: 'linux', cwd: '/tmp', env: {} }))
      .toEqual({ command: 'npm', shell: false });
  });
});
