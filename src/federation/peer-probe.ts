/**
 * ピア 1 件へ health を 1 回問い合わせ、 結果を巡回キャッシュと DB (last_ok_at / last_error) に反映する。
 *
 * 周期巡回 (peer-poller.ts) と疎通テスト (peer-routes.ts の `/test`) が同じ手順を踏むので、
 * ここに 1 か所だけ置く (片方だけ検証や記録の仕方がずれないように)。
 */

import { fetchHealth, type PeerCallResult } from './client.js';
import { recordPeerPoll, type PeerPollOutcome } from './peer-cache.js';
import { classifyPeerResponse } from './peer-response.js';
import { markPeerResult, type RemotePeer } from './store.js';

/** @implements SPEC-FEDERATION-HEALTH-CACHE */

export interface PeerProbeDeps {
  now?: () => number;
  fetch?: (peer: RemotePeer, timeoutMs: number) => Promise<PeerCallResult<unknown>>;
}

export interface PeerProbeResult {
  outcome: PeerPollOutcome;
  /** HTTP ステータス (接続できなかったときは null)。 */
  httpStatus: number | null;
}

export async function probePeer(peer: RemotePeer, timeoutMs: number, deps: PeerProbeDeps = {}): Promise<PeerProbeResult> {
  const now = deps.now ?? Date.now;
  const fetchPeer = deps.fetch ?? fetchHealth;
  const startedAt = now();
  const result = await fetchPeer(peer, timeoutMs);
  const outcome = classifyPeerResponse(result, Math.max(0, now() - startedAt));
  recordPeerPoll(peer, outcome, now());
  markPeerResult(peer.id, outcome.ok, outcome.error);
  return { outcome, httpStatus: result.status };
}
