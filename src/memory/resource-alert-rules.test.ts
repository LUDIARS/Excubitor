import { describe, expect, it } from 'vitest';
import { evaluateResourceAlerts, type ResourceAlertRules } from './resource-alert-rules.js';
import { withSince } from './resource-alerts.js';
import { parseVmStatAvailableBytes } from './resource-sampler.js';

const GiB = 1024 ** 3;
const rules: ResourceAlertRules = {
  diskFreeWarnPct: 10,
  diskFreeCriticalPct: 5,
  memoryWarnPct: 90,
  memoryCriticalPct: 97,
  memoryWindowMs: 10 * 60_000,
  cpuThresholdPct: 85,
  cpuWindowMs: 15 * 60_000,
  sustainedRatio: 0.8,
  minSamples: 5,
};

function series(minutes: number, value: (i: number) => number): Array<{ t: number; pct: number; cpu: number }> {
  return Array.from({ length: minutes + 1 }, (_, i) => ({ t: i * 60_000, pct: value(i), cpu: value(i) }));
}

describe('evaluateResourceAlerts', () => {
  it('is quiet when disks have room and load is normal', () => {
    const load = series(15, () => 40);
    expect(evaluateResourceAlerts({ disks: [{ path: '/', freeBytes: 200 * GiB, totalBytes: 500 * GiB }], memory: load, cpu: load }, rules)).toEqual([]);
  });

  it('grades low disk space as warn, then critical', () => {
    const warn = evaluateResourceAlerts({ disks: [{ path: '/data', freeBytes: 8 * GiB, totalBytes: 100 * GiB }], memory: [], cpu: [] }, rules);
    expect(warn).toMatchObject([{ key: 'disk:/data', kind: 'disk', level: 'warn', value_pct: 8, threshold_pct: 10 }]);
    const critical = evaluateResourceAlerts({ disks: [{ path: '/data', freeBytes: 3 * GiB, totalBytes: 100 * GiB }], memory: [], cpu: [] }, rules);
    expect(critical).toMatchObject([{ level: 'critical', threshold_pct: 5 }]);
  });

  it('ignores a single memory spike but reports sustained pressure', () => {
    const spike = series(10, (i) => (i === 10 ? 99 : 50));
    expect(evaluateResourceAlerts({ disks: [], memory: spike, cpu: [] }, rules)).toEqual([]);
    const sustained = series(10, () => 98);
    expect(evaluateResourceAlerts({ disks: [], memory: sustained, cpu: [] }, rules)).toMatchObject([{ key: 'memory', level: 'critical' }]);
  });

  it('reports sustained CPU saturation', () => {
    const busy = series(15, () => 95);
    expect(evaluateResourceAlerts({ disks: [], memory: [], cpu: busy }, rules)).toMatchObject([{ key: 'cpu', kind: 'cpu', level: 'warn' }]);
  });
});

describe('withSince', () => {
  it('keeps the first detection time while the same alert continues', () => {
    const alert = { key: 'cpu', kind: 'cpu' as const, level: 'warn' as const, message: '', value_pct: 95, threshold_pct: 85 };
    const first = withSince([alert], [], 1_000);
    expect(withSince([alert], first, 5_000)[0]!.since).toBe(1_000);
    expect(withSince([alert], [], 5_000)[0]!.since).toBe(5_000);
  });
});

describe('parseVmStatAvailableBytes', () => {
  it('counts free, inactive and speculative pages as available on macOS', () => {
    const output = [
      'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
      'Pages free:                               10000.',
      'Pages active:                            200000.',
      'Pages inactive:                           50000.',
      'Pages speculative:                         2000.',
      'Pages wired down:                        100000.',
    ].join('\n');
    expect(parseVmStatAvailableBytes(output)).toBe((10000 + 50000 + 2000) * 16384);
  });

  it('returns null for unexpected output', () => {
    expect(parseVmStatAvailableBytes('nothing here')).toBeNull();
  });
});
