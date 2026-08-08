import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  BREAKAWAY_SPEC_ENV,
  launchBreakawayChild,
  parseLaunchSpec,
  readLaunchSpec,
  writeLaunchResult,
  type BreakawayLaunchSpec,
} from './breakaway-launcher.js';

const temporaryDirs: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ex-breakaway-'));
  temporaryDirs.push(dir);
  return dir;
}

function spec(dir: string, overrides: Partial<BreakawayLaunchSpec> = {}): BreakawayLaunchSpec {
  return {
    command: process.execPath,
    args: ['-e', 'process.stdout.write("hello")'],
    shell: false,
    stdoutPath: join(dir, 'svc.out.log'),
    stderrPath: join(dir, 'svc.err.log'),
    resultPath: join(dir, 'result.json'),
    ...overrides,
  };
}

afterEach(() => {
  while (temporaryDirs.length > 0) {
    rmSync(temporaryDirs.pop()!, { recursive: true, force: true });
  }
});

describe('readLaunchSpec', () => {
  it('takes the spec from env and keeps it out of the child environment', () => {
    const encoded = Buffer.from(JSON.stringify(spec('E:\\logs')), 'utf8').toString('base64');

    const { spec: parsed, childEnv } = readLaunchSpec({
      [BREAKAWAY_SPEC_ENV]: encoded,
      excubitor_breakaway_spec: 'shadowed-control-value',
      SECRET_TOKEN: 'hunter2',
      UNSET: undefined,
    });

    expect(parsed.command).toBe(process.execPath);
    expect(childEnv).toEqual({ SECRET_TOKEN: 'hunter2' });
  });

  it('fails when there is nothing to launch', () => {
    expect(() => readLaunchSpec({})).toThrow(/is not set/);
  });
});

describe('parseLaunchSpec', () => {
  it('rejects a spec that would silently launch something else', () => {
    expect(() => parseLaunchSpec('nope')).toThrow(/not valid JSON/);
    expect(() => parseLaunchSpec('null')).toThrow(/must be a JSON object/);
    expect(() => parseLaunchSpec('{}')).toThrow(/args must be an array/);
    expect(() => parseLaunchSpec('{"args":["a"],"shell":"yes"}')).toThrow(/shell must be a boolean/);
    expect(() => parseLaunchSpec('{"args":[],"shell":false}')).toThrow(/missing command/);
  });

  it('keeps cwd optional', () => {
    const parsed = parseLaunchSpec(
      JSON.stringify({
        command: 'app.exe',
        args: [],
        shell: false,
        stdoutPath: 'o',
        stderrPath: 'e',
        resultPath: 'r',
      }),
    );
    expect(parsed.cwd).toBeUndefined();
  });
});

describe('writeLaunchResult', () => {
  it('publishes the result atomically (no partially written file to read)', () => {
    const dir = workspace();
    const resultPath = join(dir, 'result.json');

    writeLaunchResult(resultPath, { pid: 42 });

    expect(JSON.parse(readFileSync(resultPath, 'utf8'))).toEqual({ pid: 42 });
  });
});

describe('launchBreakawayChild', () => {
  it('starts the child, appends to the logs and reports the real pid', async () => {
    const dir = workspace();
    const launch = spec(dir, {
      args: ['-e', 'process.stdout.write("out"); process.stderr.write("err")'],
    });
    writeFileSync(launch.stdoutPath, 'existing\n', 'utf8');

    expect(await launchBreakawayChild(launch, { ...process.env } as Record<string, string>)).toBe(0);

    const result = JSON.parse(readFileSync(launch.resultPath, 'utf8')) as { pid: number };
    expect(result.pid).toBeGreaterThan(0);
    // 追記であって切り詰めではない (再起動でログを失わない)。
    await waitFor(() => readFileSync(launch.stdoutPath, 'utf8').includes('out'));
    expect(readFileSync(launch.stdoutPath, 'utf8')).toContain('existing');
    await waitFor(() => readFileSync(launch.stderrPath, 'utf8').includes('err'));
  });

  it('opens logs with sharing so a leftover holder cannot block the start', async () => {
    // cmd.exe の `>>` は書き込み共有を許さずに開くため、旧インスタンスがログを掴んでいると
    // 次の起動が無出力で即死していた (2026-08-08 GLab)。 launcher は通常の append open を
    // 使うので、同じログを掴んだプロセスが生きていても起動できる。
    const dir = workspace();
    const holder = spec(dir, { args: ['-e', 'setTimeout(() => {}, 3000)'] });
    expect(await launchBreakawayChild(holder, { ...process.env } as Record<string, string>)).toBe(0);
    const holderPid = (JSON.parse(readFileSync(holder.resultPath, 'utf8')) as { pid: number }).pid;

    try {
      const second = spec(dir, {
        args: ['-e', 'process.stdout.write("second")'],
        resultPath: join(dir, 'result2.json'),
      });
      expect(await launchBreakawayChild(second, { ...process.env } as Record<string, string>)).toBe(0);
      expect(JSON.parse(readFileSync(second.resultPath, 'utf8'))).toMatchObject({
        pid: expect.any(Number),
      });
    } finally {
      try {
        process.kill(holderPid);
      } catch {
        // 既に終わっていれば何もしない。
      }
    }
  });

  it('reports why the child could not start instead of dying silently', async () => {
    const dir = workspace();
    const launch = spec(dir, { command: join(dir, 'does-not-exist.exe'), args: [] });

    expect(await launchBreakawayChild(launch, {})).toBe(1);

    const result = JSON.parse(readFileSync(launch.resultPath, 'utf8')) as { error: string };
    expect(result.error).toMatch(/ENOENT|spawn/i);
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (condition()) return;
    if (Date.now() >= deadline) throw new Error('condition was not met in time');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
