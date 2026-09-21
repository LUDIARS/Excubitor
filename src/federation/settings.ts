/**
 * 拠点間連携の周期・タイムアウト・鮮度の解決 (catalog の `federation:` + 既定値)。
 */

import type { Catalog } from '../catalog/loader.js';

/** @implements SPEC-FEDERATION-HEALTH-CACHE */

export const DEFAULT_PEER_POLL_SEC = 60;
export const DEFAULT_PEER_TIMEOUT_MS = 5_000;
export const DEFAULT_STALE_AFTER_SEC = 180;

export interface FederationSettings {
  peerPollMs: number;
  peerTimeoutMs: number;
  staleAfterMs: number;
}

export function federationSettings(catalog: Pick<Catalog, 'federation'>): FederationSettings {
  const federation = catalog.federation;
  return {
    peerPollMs: (federation?.peer_poll_sec ?? DEFAULT_PEER_POLL_SEC) * 1000,
    peerTimeoutMs: federation?.peer_timeout_ms ?? DEFAULT_PEER_TIMEOUT_MS,
    staleAfterMs: (federation?.stale_after_sec ?? DEFAULT_STALE_AFTER_SEC) * 1000,
  };
}
