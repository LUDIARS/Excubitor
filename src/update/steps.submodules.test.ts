import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { execCapture } from '../shared/exec.js';
import { syncSubmodules } from './steps.js';

type Exec = typeof execCapture;

function fakeExec(results: Array<{ ok: boolean; stdout?: string; stderr?: string }>) {
  const calls: string[][] = [];
  const exec = vi.fn(async (_cmd: string, args: string[]) => {
    calls.push(args);
    const next = results.shift() ?? { ok: true };
    return { ok: next.ok, code: next.ok ? 0 : 1, stdout: next.stdout ?? '', stderr: next.stderr ?? '' };
  }) as unknown as Exec;
  return { exec, calls };
}

describe('syncSubmodules', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ex-submodules-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('skips repositories without submodules', async () => {
    const { exec, calls } = fakeExec([]);
    expect(await syncSubmodules(dir, exec)).toBeNull();
    expect(calls).toEqual([]);
  });

  it('syncs URLs and then checks out the recorded submodule revisions', async () => {
    writeFileSync(join(dir, '.gitmodules'), '[submodule "lib/lapilli"]\n\tpath = lib/lapilli\n');
    const { exec, calls } = fakeExec([
      { ok: true },
      { ok: true, stdout: "Submodule path 'lib/lapilli': checked out '07f1629'" },
    ]);

    const step = await syncSubmodules(dir, exec);

    expect(calls).toEqual([
      ['submodule', 'sync', '--recursive'],
      ['submodule', 'update', '--init', '--recursive'],
    ]);
    expect(step).toEqual({
      step: 'submodules',
      ok: true,
      detail: "Submodule path 'lib/lapilli': checked out '07f1629'",
    });
  });

  it('reports an already aligned checkout as up to date', async () => {
    writeFileSync(join(dir, '.gitmodules'), '');
    const { exec } = fakeExec([{ ok: true }, { ok: true }]);
    expect(await syncSubmodules(dir, exec)).toEqual({ step: 'submodules', ok: true, detail: 'up to date' });
  });

  it('fails the step (so build never runs on an empty submodule) when the update cannot fetch', async () => {
    writeFileSync(join(dir, '.gitmodules'), '');
    const { exec } = fakeExec([
      { ok: true },
      { ok: false, stderr: "fatal: unable to access 'https://github.com/LUDIARS/Lapilli.git/'" },
    ]);
    const step = await syncSubmodules(dir, exec);
    expect(step?.ok).toBe(false);
    expect(step?.detail).toContain('unable to access');
  });

  it('stops before update when the URL sync fails', async () => {
    writeFileSync(join(dir, '.gitmodules'), '');
    const { exec, calls } = fakeExec([{ ok: false, stderr: 'sync failed' }]);
    const step = await syncSubmodules(dir, exec);
    expect(step).toEqual({ step: 'submodules', ok: false, detail: 'sync failed' });
    expect(calls).toHaveLength(1);
  });
});
