import { describe, it, expect } from 'vitest';
import { detectSustainedCpu, type CpuSample } from './cpu-alert.js';

const WINDOW = 20 * 60_000; // 20min
const opts = { windowMs: WINDOW, thresholdPct: 85, sustainedRatio: 0.8, minSamples: 8 };

/** step ms 間隔で cpu 値の系列を作る。 */
function series(values: number[], stepMs = 60_000): CpuSample[] {
  return values.map((cpu, i) => ({ t: 1_000_000 + i * stepMs, cpu }));
}

describe('detectSustainedCpu', () => {
  it('サンプル不足は insufficient', () => {
    expect(detectSustainedCpu(series([90, 90, 90]), opts).verdict).toBe('insufficient');
  });

  it('低負荷継続は ok', () => {
    const r = detectSustainedCpu(series(Array(12).fill(20)), opts);
    expect(r.verdict).toBe('ok');
    expect(r.highRatio).toBe(0);
  });

  it('高負荷が継続していれば high', () => {
    const r = detectSustainedCpu(series(Array(12).fill(95)), opts);
    expect(r.verdict).toBe('high');
    expect(r.highRatio).toBe(1);
    expect(r.avgPct).toBe(95);
    expect(r.maxPct).toBe(95);
  });

  it('一過性スパイク 1 発では high にしない (sustained 未満)', () => {
    // 12 サンプル中 1 つだけ高 → ratio ≈ 0.083 < 0.8
    const vals = Array(12).fill(20);
    vals[5] = 99;
    expect(detectSustainedCpu(series(vals), opts).verdict).toBe('ok');
  });

  it('観測スパンが短すぎる (minSpan 未満) は insufficient', () => {
    // 8 サンプルを 10s 間隔 = span 70s < windowMs/2(=10min)
    expect(detectSustainedCpu(series(Array(8).fill(95), 10_000), opts).verdict).toBe('insufficient');
  });

  it('窓外の古いサンプルは判定に含めない', () => {
    // 古い低負荷を大量 + 直近の高負荷のみ窓内
    const old = series(Array(20).fill(10), 60_000);
    const recentStart = old[old.length - 1]!.t + 30 * 60_000; // 窓外へずらす
    // 窓内に収まり minSpan(=10min) を超える長さにする (14 サンプル = 13min span)。
    const recent: CpuSample[] = Array(14).fill(0).map((_, i) => ({ t: recentStart + i * 60_000, cpu: 95 }));
    const r = detectSustainedCpu([...old, ...recent], opts);
    expect(r.verdict).toBe('high');
  });
});
