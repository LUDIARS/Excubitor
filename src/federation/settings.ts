/**
 * 拠点間連携の周期・タイムアウト・鮮度の解決 (catalog の `federation:` + 既定値)。
 */

import type { Catalog } from '../catalog/loader.js';

/** @implements SPEC-FEDERATION-HEALTH-CACHE */

export const DEFAULT_PEER_POLL_SEC = 60;
export const DEFAULT_PEER_TIMEOUT_MS = 5_000;
export const DEFAULT_STALE_AFTER_SEC = 180;
export const DEFAULT_PEER_DOWN_AFTER_SEC = 300;

export interface FederationSettings {
  peerPollMs: number;
  peerTimeoutMs: number;
  staleAfterMs: number;
  /**
   * 本社としてピアの応答なし・資源アラートを通知する。 相互登録で全拠点が互いを巡回するため、
   * 拠点ごとの env で本社 1 拠点だけ有効にする (git 共有の config には置かない)。
   */
  alertNotify: boolean;
  peerDownAfterMs: number;
}

export function federationSettings(catalog: Pick<Catalog, 'federation'>): FederationSettings {
  const federation = catalog.federation;
  return {
    peerPollMs: (federation?.peer_poll_sec ?? DEFAULT_PEER_POLL_SEC) * 1000,
    peerTimeoutMs: federation?.peer_timeout_ms ?? DEFAULT_PEER_TIMEOUT_MS,
    staleAfterMs: (federation?.stale_after_sec ?? DEFAULT_STALE_AFTER_SEC) * 1000,
    alertNotify: isTruthy(process.env.EXCUBITOR_FEDERATION_ALERT_NOTIFY),
    peerDownAfterMs: (federation?.peer_down_after_sec ?? DEFAULT_PEER_DOWN_AFTER_SEC) * 1000,
  };
}

function isTruthy(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? '');
}
