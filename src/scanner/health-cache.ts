/**
 * 死活確認の最新結果をメモリに保持する。
 *
 * 死活を返す API (拠点間の `/api/v1/federation/health` など) はこのキャッシュを読むだけで、
 * 呼ばれたからといって probe を走らせない。 probe は監視ループの周期でしか起きないので、
 * 何拠点・何回問い合わせられても監視対象へ届く負荷は一定になる。
 *
 * 値は監視ループが 1 周ごとに丸ごと差し替える (部分更新しない)。 起動直後の最初の 1 周が
 * 終わるまでは空で、 呼び出し側は `completedAt: null` でそれを知る。
 */

import type { ServiceHealthResult } from './health.js';

/** @implements SPEC-MONITOR-LIGHTWEIGHT */

export interface CachedServiceHealth {
  ok: boolean;
  reason: ServiceHealthResult['reason'];
  detail: string | null;
  reportedVersion: string | null;
  /** この結果を得た probe の時刻 (epoch ms)。 */
  checkedAt: number;
}

export interface HealthCacheSnapshot {
  /** 直近で完了した周の開始・完了時刻。 1 周も終わっていなければ null。 */
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
  /** 監視ループの周期 (ms)。 呼び出し側が鮮度を判断するのに使う。 */
  intervalMs: number | null;
  services: ReadonlyMap<string, CachedServiceHealth>;
}

let current: HealthCacheSnapshot = emptySnapshot();

function emptySnapshot(): HealthCacheSnapshot {
  return { startedAt: null, completedAt: null, durationMs: null, intervalMs: null, services: new Map() };
}

/** 1 周分の結果で丸ごと差し替える。 */
export function publishHealthResults(input: {
  startedAt: number;
  completedAt: number;
  intervalMs: number;
  results: ReadonlyMap<string, ServiceHealthResult>;
}): HealthCacheSnapshot {
  const services = new Map<string, CachedServiceHealth>();
  for (const [code, result] of input.results) {
    services.set(code, {
      ok: result.ok,
      reason: result.reason,
      detail: result.detail ?? null,
      reportedVersion: result.reportedVersion ?? null,
      checkedAt: input.completedAt,
    });
  }
  current = {
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    durationMs: Math.max(0, input.completedAt - input.startedAt),
    intervalMs: input.intervalMs,
    services,
  };
  return current;
}

export function getHealthCache(): HealthCacheSnapshot {
  return current;
}

/** テスト用。 */
export function clearHealthCache(): void {
  current = emptySnapshot();
}
