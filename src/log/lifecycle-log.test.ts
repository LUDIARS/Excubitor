import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../shared/logger.js', () => ({
  createNamedLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { appendLifecycleEvent, formatLifecycleEvent, START_FAILURE_MARKER } from './lifecycle-log.js';

const NOW = new Date('2026-10-03T01:02:03.000Z');

describe('formatLifecycleEvent', () => {
  it('writes the start banner with command, cwd, version and strategy to stdout', () => {
    const out = formatLifecycleEvent({
      kind: 'start',
      command: 'node --run dev',
      cwd: 'E:/Document/Ars/GLAB',
      version: 'abc1234',
      restartCount: 2,
      strategy: 'job-breakaway',
    }, NOW);
    expect(out.channel).toBe('stdout');
    expect(out.lines).toEqual([
      '[excubitor] 2026-10-03T01:02:03.000Z ===== start strategy=job-breakaway restart=2 version=abc1234',
      '[excubitor] 2026-10-03T01:02:03.000Z command="node --run dev" cwd="E:/Document/Ars/GLAB"',
    ]);
  });

  it('writes the spawned pid to stdout', () => {
    expect(formatLifecycleEvent({ kind: 'spawned', pid: 33908, strategy: 'child' }, NOW)).toEqual({
      channel: 'stdout',
      lines: ['[excubitor] 2026-10-03T01:02:03.000Z spawned pid=33908 strategy=child'],
    });
  });

  it('marks start failures on stderr and indents the remaining message lines', () => {
    const out = formatLifecycleEvent({
      kind: 'start-failed',
      message: 'service glab exited immediately after breakaway spawn (pid=1);\nsecond line',
      retainedPid: null,
    }, NOW);
    expect(out.channel).toBe('stderr');
    expect(out.lines[0]).toContain(START_FAILURE_MARKER);
    expect(out.lines[0]).toContain('start failed: service glab exited immediately');
    expect(out.lines.slice(1)).toEqual(['[excubitor]   second line']);
  });

  it('mentions a surviving pid on start failure', () => {
    const out = formatLifecycleEvent({ kind: 'start-failed', message: 'unverified', retainedPid: 42 }, NOW);
    expect(out.lines[0]).toContain('(pid 42 may still be running)');
  });

  it('marks build failures and keeps only the tail of long output', () => {
    const output = `${'x'.repeat(3000)}\nlast error line`;
    const out = formatLifecycleEvent({
      kind: 'build-failed',
      reason: 'manual-start',
      command: 'npm run build',
      exitCode: 1,
      output,
    }, NOW);
    expect(out.channel).toBe('stderr');
    expect(out.lines[0]).toBe(
      `[excubitor] 2026-10-03T01:02:03.000Z ${START_FAILURE_MARKER} build failed reason=manual-start exit=1 command="npm run build"`,
    );
    expect(out.lines.at(-1)).toBe('[excubitor]   last error line');
    expect(out.lines.join('\n').length).toBeLessThan(2300);
  });

  it('omits the detail block when the build produced no output', () => {
    const out = formatLifecycleEvent({
      kind: 'build-failed', reason: 'auto-restart', command: 'npm run build', exitCode: null, output: '  ',
    }, NOW);
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toContain('exit=null');
  });
});

describe('appendLifecycleEvent', () => {
  let dir: string;
  const previous = process.env.EXCUBITOR_PROCESS_LOG_DIR;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ex-lifecycle-'));
    process.env.EXCUBITOR_PROCESS_LOG_DIR = dir;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.EXCUBITOR_PROCESS_LOG_DIR;
    else process.env.EXCUBITOR_PROCESS_LOG_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('appends after existing service output in the channel file', () => {
    fs.writeFileSync(path.join(dir, 'svc.out.log'), 'service line\n');
    appendLifecycleEvent('svc', { kind: 'spawned', pid: 7, strategy: 'child' });
    appendLifecycleEvent('svc', { kind: 'start-failed', message: 'boom', retainedPid: null });

    const out = fs.readFileSync(path.join(dir, 'svc.out.log'), 'utf8').split('\n');
    expect(out[0]).toBe('service line');
    expect(out[1]).toMatch(/^\[excubitor\] \S+ spawned pid=7 strategy=child$/);
    const err = fs.readFileSync(path.join(dir, 'svc.err.log'), 'utf8');
    expect(err).toContain(`${START_FAILURE_MARKER} start failed: boom`);
  });

  it('does not throw when the log directory cannot be written', () => {
    process.env.EXCUBITOR_PROCESS_LOG_DIR = path.join(dir, 'missing', 'nested');
    expect(() => appendLifecycleEvent('svc', { kind: 'spawned', pid: 1, strategy: 'child' })).not.toThrow();
  });
});
