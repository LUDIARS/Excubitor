import { describe, it, expect } from 'vitest';
import { detectLeak, type LeakSample } from './leak.js';

const MB = 1024 * 1024;
const WINDOW = 60 * 60_000; // 60 分
const OPTS = { windowMs: WINDOW, thresholdBytesPerHour: 50 * MB, minSamples: 8 };

/** [0, window] を n 等分し、 rssFn(i/(n-1)) で RSS を決める系列を作る。 */
function series(n: number, rssFn: (frac: number) => number): LeakSample[] {
  const out: LeakSample[] = [];
  for (let i = 0; i < n; i++) {
    const frac = i / (n - 1);
    out.push({ t: Math.round(frac * WINDOW), rss: rssFn(frac) });
  }
  return out;
}

describe('detectLeak', () => {
  it('サンプル不足は insufficient', () => {
    const r = detectLeak(series(3, () => 100 * MB), OPTS);
    expect(r.verdict).toBe('insufficient');
  });

  it('平坦は ok (slope ~0)', () => {
    const r = detectLeak(series(10, () => 100 * MB), OPTS);
    expect(r.verdict).toBe('ok');
    expect(Math.abs(r.slopeBytesPerHour)).toBeLessThan(5 * MB);
  });

  it('一定速度で増加し続けると leaking', () => {
    // 100MB → 200MB を 60 分で = 100MB/h、 閾値 50MB/h 超、 単調増加。
    const r = detectLeak(series(10, (f) => (100 + 100 * f) * MB), OPTS);
    expect(r.verdict).toBe('leaking');
    expect(r.slopeBytesPerHour).toBeGreaterThan(80 * MB);
    expect(r.monotonicRatio).toBe(1);
  });

  it('鋸歯状 (GC で増減を繰り返す) は leaking にしない', () => {
    // 100,150 を往復 (純増なし)。
    const r = detectLeak(series(10, (f) => (Math.round(f * 9) % 2 === 0 ? 100 : 150) * MB), OPTS);
    expect(r.verdict).not.toBe('leaking');
  });

  it('上昇ドリフトでも大きな drop を伴えば leaking にしない (suspect 止まり)', () => {
    // 100,200,110,210,... ドリフトはあるが毎回 drop → monotonicRatio 低い。
    const vals = [100, 200, 110, 210, 120, 220, 130, 230];
    const samples = vals.map((v, i) => ({ t: Math.round((i / (vals.length - 1)) * WINDOW), rss: v * MB }));
    const r = detectLeak(samples, OPTS);
    expect(r.verdict).not.toBe('leaking');
    expect(r.monotonicRatio).toBeLessThan(0.6);
  });

  it('窓の外の古いサンプルは無視する', () => {
    // 古い (window 前) に巨大値、 窓内は平坦 → ok のまま。
    const old: LeakSample[] = [{ t: -2 * WINDOW, rss: 10_000 * MB }];
    const recent = series(10, () => 100 * MB);
    const r = detectLeak([...old, ...recent], OPTS);
    expect(r.verdict).toBe('ok');
  });
});
