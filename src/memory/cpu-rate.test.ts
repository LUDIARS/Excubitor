import { describe, it, expect, beforeEach } from 'vitest';
import { cpuPctFromDelta, recordAndComputeCpuPct, resetCpuRateState } from './cpu-rate.js';

describe('cpuPctFromDelta', () => {
  it('1 コア占有 = 100% / cpuCount に正規化', () => {
    // 1 秒で 1 秒分 (1000ms) の CPU を使用 → 1 コア相当。 4 コアなら 25%。
    const prev = { cpuMs: 0, atMs: 0, pid: 1 };
    const curr = { cpuMs: 1000, atMs: 1000, pid: 1 };
    expect(cpuPctFromDelta(prev, curr, 4)).toBe(25);
    expect(cpuPctFromDelta(prev, curr, 1)).toBe(100);
  });

  it('全コア飽和でも 100% にクランプ', () => {
    const prev = { cpuMs: 0, atMs: 0, pid: 1 };
    const curr = { cpuMs: 8000, atMs: 1000, pid: 1 }; // 8 コア分を 4 コアで
    expect(cpuPctFromDelta(prev, curr, 4)).toBe(100);
  });

  it('時間が進まない / 累積巻き戻りは null', () => {
    expect(cpuPctFromDelta({ cpuMs: 0, atMs: 100, pid: 1 }, { cpuMs: 50, atMs: 100, pid: 1 }, 4)).toBeNull();
    expect(cpuPctFromDelta({ cpuMs: 100, atMs: 0, pid: 1 }, { cpuMs: 50, atMs: 1000, pid: 1 }, 4)).toBeNull();
  });
});

describe('recordAndComputeCpuPct', () => {
  beforeEach(() => resetCpuRateState());

  it('初回 tick は null、 2 回目から delta で算出', () => {
    expect(recordAndComputeCpuPct('svc', 0, 0, 100, 4)).toBeNull();
    expect(recordAndComputeCpuPct('svc', 1000, 1000, 100, 4)).toBe(25);
  });

  it('pid が変わったら (再起動) null にリセット', () => {
    recordAndComputeCpuPct('svc', 5000, 0, 100, 4);
    // pid が 200 に変化 → 累積はリセットされているので算出しない
    expect(recordAndComputeCpuPct('svc', 100, 1000, 200, 4)).toBeNull();
    // 次の同 pid tick からは算出
    expect(recordAndComputeCpuPct('svc', 1100, 2000, 200, 4)).toBe(25);
  });

  it('cpuMs が null なら null', () => {
    expect(recordAndComputeCpuPct('svc', null, 1000, 100, 4)).toBeNull();
  });
});
