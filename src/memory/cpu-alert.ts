/**
 * CPU 高止まり検知 (pure)。
 *
 * leak (memory/leak.ts) が「単調増加トレンド」を見るのに対し、 CPU は瞬間スパイクを
 * 弾いて「窓内で高負荷が継続しているか」を見る。 一過性のピーク 1 発では起票せず、
 * 観測窓のサンプルのうち閾値超えの割合 (sustained ratio) が十分高いときだけ 'high'。
 *
 * cpu は 0-100 (%) を想定 (cpu-rate / docker / host が全マシン比で揃えている)。
 */

export interface CpuSample {
  /** epoch ms。 */
  t: number;
  /** CPU 使用率 (%)。 null は除外して渡すこと。 */
  cpu: number;
}

export type CpuVerdict = 'insufficient' | 'ok' | 'high';

export interface CpuAlertOptions {
  /** 観測窓 (ms)。 最新サンプルからこの幅だけ遡って判定する。 */
  windowMs: number;
  /** この % 以上を「高負荷サンプル」とみなす。 */
  thresholdPct: number;
  /** 窓内サンプルのうち高負荷だった割合の下限 (これ以上で high)。 */
  sustainedRatio: number;
  /** 判定に最低限必要なサンプル数。 */
  minSamples: number;
  /** 判定に最低限必要な観測スパン (ms)。 既定は windowMs の半分。 */
  minSpanMs?: number;
}

export interface CpuAlertResult {
  verdict: CpuVerdict;
  /** 窓内で閾値超えだったサンプルの割合 (0-1)。 */
  highRatio: number;
  /** 窓内 CPU% の平均。 */
  avgPct: number;
  /** 窓内 CPU% の最大。 */
  maxPct: number;
  samples: number;
  spanMs: number;
}

const INSUFFICIENT: CpuAlertResult = {
  verdict: 'insufficient',
  highRatio: 0,
  avgPct: 0,
  maxPct: 0,
  samples: 0,
  spanMs: 0,
};

/** 観測窓内の CPU 系列から高止まり判定を返す。 入力は順不同・null 除外済みを想定。 */
export function detectSustainedCpu(input: CpuSample[], opts: CpuAlertOptions): CpuAlertResult {
  const minSpanMs = opts.minSpanMs ?? opts.windowMs / 2;

  const clean = input
    .filter((s) => Number.isFinite(s.t) && Number.isFinite(s.cpu))
    .sort((a, b) => a.t - b.t);
  if (clean.length === 0) return INSUFFICIENT;

  const maxT = clean[clean.length - 1]!.t;
  const windowed = clean.filter((s) => s.t >= maxT - opts.windowMs);
  const n = windowed.length;
  if (n < opts.minSamples) return { ...INSUFFICIENT, samples: n };

  const spanMs = windowed[n - 1]!.t - windowed[0]!.t;
  if (spanMs < minSpanMs) return { ...INSUFFICIENT, samples: n, spanMs };

  let high = 0;
  let sum = 0;
  let max = 0;
  for (const s of windowed) {
    if (s.cpu >= opts.thresholdPct) high += 1;
    sum += s.cpu;
    if (s.cpu > max) max = s.cpu;
  }
  const highRatio = high / n;
  const avgPct = Math.round((sum / n) * 10) / 10;
  const maxPct = Math.round(max * 10) / 10;

  const verdict: CpuVerdict = highRatio >= opts.sustainedRatio ? 'high' : 'ok';
  return { verdict, highRatio, avgPct, maxPct, samples: n, spanMs };
}
