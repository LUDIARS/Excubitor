/**
 * メモリリーク検知 (pure)。
 *
 * 観測窓の RSS 時系列から「単調に増え続けているか」を判定する。 単純な閾値超過では
 * GC による鋸歯状 (sawtooth) パターンを誤検知するため、 2 つの指標を併用する:
 *   1. slope: 最小二乗法による線形回帰の傾き (bytes/hour)。 増加トレンドの強さ。
 *   2. monotonicRatio: 連続サンプル差分のうち「非減少」の割合。 鋸歯状を弾く。
 * leak = slope が閾値超 かつ 単調増加寄り かつ 最新値がベースラインを十分上回る。
 */

export interface LeakSample {
  /** epoch ms。 */
  t: number;
  /** RSS バイト。 */
  rss: number;
}

export type LeakVerdict = 'insufficient' | 'ok' | 'suspect' | 'leaking';

export interface LeakOptions {
  /** 観測窓 (ms)。 最新サンプルからこの幅だけ遡って判定する。 */
  windowMs: number;
  /** leak と判定する slope の下限 (bytes/hour)。 */
  thresholdBytesPerHour: number;
  /** 判定に最低限必要なサンプル数。 */
  minSamples: number;
  /** 判定に最低限必要な観測スパン (ms)。 既定は windowMs の半分。 */
  minSpanMs?: number;
}

export interface LeakResult {
  verdict: LeakVerdict;
  slopeBytesPerHour: number;
  monotonicRatio: number;
  baselineBytes: number | null;
  latestBytes: number | null;
  samples: number;
  spanMs: number;
}

const INSUFFICIENT: LeakResult = {
  verdict: 'insufficient',
  slopeBytesPerHour: 0,
  monotonicRatio: 0,
  baselineBytes: null,
  latestBytes: null,
  samples: 0,
  spanMs: 0,
};

/**
 * 観測窓内の RSS 系列から leak 判定を返す。 入力は順不同・null 混在でも安全。
 */
export function detectLeak(input: LeakSample[], opts: LeakOptions): LeakResult {
  const minSpanMs = opts.minSpanMs ?? opts.windowMs / 2;

  const clean = input
    .filter((s) => Number.isFinite(s.t) && Number.isFinite(s.rss))
    .sort((a, b) => a.t - b.t);
  if (clean.length === 0) return INSUFFICIENT;

  const maxT = clean[clean.length - 1]!.t;
  const windowed = clean.filter((s) => s.t >= maxT - opts.windowMs);
  const n = windowed.length;
  if (n < opts.minSamples) return { ...INSUFFICIENT, samples: n };

  const first = windowed[0]!;
  const last = windowed[n - 1]!;
  const spanMs = last.t - first.t;
  if (spanMs < minSpanMs) {
    return { ...INSUFFICIENT, samples: n, spanMs, baselineBytes: first.rss, latestBytes: last.rss };
  }

  const slopeBytesPerHour = leastSquaresSlopePerHour(windowed);
  const monotonicRatio = nonDecreasingRatio(windowed);
  const baselineBytes = first.rss;
  const latestBytes = last.rss;

  const grewEnough = latestBytes >= baselineBytes * 1.15;
  let verdict: LeakVerdict = 'ok';
  if (
    slopeBytesPerHour >= opts.thresholdBytesPerHour &&
    monotonicRatio >= 0.6 &&
    grewEnough
  ) {
    verdict = 'leaking';
  } else if (slopeBytesPerHour >= opts.thresholdBytesPerHour * 0.5 && monotonicRatio >= 0.5) {
    verdict = 'suspect';
  }

  return { verdict, slopeBytesPerHour, monotonicRatio, baselineBytes, latestBytes, samples: n, spanMs };
}

/** 最小二乗法で傾き (bytes/ms) を求め bytes/hour に換算。 t は first を 0 とした相対 ms。 */
function leastSquaresSlopePerHour(samples: LeakSample[]): number {
  const n = samples.length;
  const t0 = samples[0]!.t;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (const s of samples) {
    const x = s.t - t0;
    const y = s.rss;
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return 0;
  const slopePerMs = (n * sumXY - sumX * sumY) / denom;
  return slopePerMs * 3_600_000;
}

/** 連続サンプル差分のうち非減少 (delta >= 0) の割合。 */
function nonDecreasingRatio(samples: LeakSample[]): number {
  if (samples.length < 2) return 0;
  let nonDec = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i]!.rss - samples[i - 1]!.rss >= 0) nonDec += 1;
  }
  return nonDec / (samples.length - 1);
}
