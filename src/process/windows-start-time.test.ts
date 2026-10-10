import { describe, expect, it, vi } from 'vitest';
import {
  parseWindowsStartTimes,
  queryWindowsStartTimes,
  WindowsStartTimeBatcher,
  windowsStartTimeScript,
} from './windows-start-time.js';

function ok(stdout: string) {
  return { ok: true, code: 0, stdout, stderr: '' };
}

describe('windows start time query', () => {
  it('asks for every pid in one Get-Process call and always exits 0', () => {
    const script = windowsStartTimeScript([10, 20, 30]);

    expect(script).toContain('Get-Process -Id 10,20,30');
    expect(script).toContain("$ErrorActionPreference='SilentlyContinue'");
    expect(script.endsWith('exit 0')).toBe(true);
  });

  it('parses one `<pid> <iso>` line per process and skips noise', () => {
    const times = parseWindowsStartTimes('10 2026-10-10T01:00:00.000Z\r\nwarning\n20 not-a-time\n');

    expect(times.get(10)).toEqual(new Date('2026-10-10T01:00:00.000Z'));
    expect(times.get(20)).toBeNull();
    expect(times.has(30)).toBe(false);
  });

  it('maps each requested pid to read / missing / unparsable', async () => {
    const run = vi.fn(async () => ok('10 2026-10-10T01:00:00.000Z\n20 garbage\n'));

    const lookups = await queryWindowsStartTimes([10, 20, 30, 10], run);

    expect(run).toHaveBeenCalledTimes(1);
    expect(lookups.get(10)).toEqual({ kind: 'started-at', startedAt: new Date('2026-10-10T01:00:00.000Z') });
    expect(lookups.get(20)).toEqual({ kind: 'unparsable' });
    expect(lookups.get(30)).toEqual({ kind: 'missing' });
  });

  it('reports failed for every pid when the query itself fails', async () => {
    const run = vi.fn(async () => ({ ok: false, code: null, stdout: '', stderr: '[timeout]' }));

    const lookups = await queryWindowsStartTimes([10, 20], run);

    expect([...lookups.values()]).toEqual([{ kind: 'failed' }, { kind: 'failed' }]);
  });

  it('does not start PowerShell for an empty request', async () => {
    const run = vi.fn(async () => ok(''));

    await expect(queryWindowsStartTimes([], run)).resolves.toEqual(new Map());
    expect(run).not.toHaveBeenCalled();
  });
});

describe('windows start time batcher', () => {
  it('shares one PowerShell run among reads that arrive in the same window', async () => {
    // 再採用サービスの数だけ PowerShell を起動していたのが負荷の原因 (2026-10-10)。
    const run = vi.fn(async (_command: string, _args: string[]) =>
      ok('10 2026-10-10T01:00:00.000Z\n20 2026-10-10T02:00:00.000Z\n'));
    const batcher = new WindowsStartTimeBatcher({ run, windowMs: 0 });

    const [a, b, again] = await Promise.all([batcher.read(10), batcher.read(20), batcher.read(10)]);

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[1]?.at(-1)).toContain('Get-Process -Id 10,20');
    expect(a).toEqual({ kind: 'started-at', startedAt: new Date('2026-10-10T01:00:00.000Z') });
    expect(b).toEqual({ kind: 'started-at', startedAt: new Date('2026-10-10T02:00:00.000Z') });
    expect(again).toEqual(a);
  });

  it('reads from the OS again on the next round instead of caching', async () => {
    // pid の再利用を見逃さないため、 結果は持ち越さない。
    const run = vi.fn()
      .mockResolvedValueOnce(ok('10 2026-10-10T01:00:00.000Z\n'))
      .mockResolvedValueOnce(ok('10 2026-10-10T05:00:00.000Z\n'));
    const batcher = new WindowsStartTimeBatcher({ run, windowMs: 0 });

    const first = await batcher.read(10);
    const second = await batcher.read(10);

    expect(run).toHaveBeenCalledTimes(2);
    expect(first).not.toEqual(second);
  });

  it('resolves every waiter as failed when the runner throws', async () => {
    const run = vi.fn(async () => { throw new Error('spawn EPERM'); });
    const batcher = new WindowsStartTimeBatcher({ run, windowMs: 0 });

    await expect(Promise.all([batcher.read(10), batcher.read(20)]))
      .resolves.toEqual([{ kind: 'failed' }, { kind: 'failed' }]);
  });
});
