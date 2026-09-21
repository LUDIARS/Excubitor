/**
 * 他拠点の health を周期的に取りに行き、 peer-cache へ載せる (拠点間ヘルスチェック)。
 *
 * 各拠点は外部へ出られないことがあるので、 通信は Tailscale / Cloudflare Mesh 等の
 * プライベート網の中だけで完結させる。 相手の base_url はメッシュ上のアドレス
 * (例 `http://100.x.y.z:17335`) を DB (remote_peers) に登録しておく。
 *
 * 1 周で有効な全ピアへ 1 回ずつ問い合わせる。 1 件分の手順 (取得・検証・記録) は peer-probe.ts。
 */

import type { Catalog } from '../catalog/loader.js';
import { createNamedLogger } from '../shared/logger.js';
import { mapWithLimit } from '../shared/map-limit.js';
import { startPeriodicTask, type PeriodicTaskHandle } from '../shared/periodic.js';
import { prunePeerStates } from './peer-cache.js';
import { probePeer, type PeerProbeDeps } from './peer-probe.js';
import { federationSettings } from './settings.js';
import { listPeers } from './store.js';

/** @implements SPEC-FEDERATION-HEALTH-CACHE */

const logger = createNamedLogger('excubitor.federation.poller');

/** 同時に問い合わせるピア数。 拠点数は少ないので小さくてよい。 */
const PEER_POLL_CONCURRENCY = 4;

export type PeerPollerDeps = PeerProbeDeps;

/** 有効な全ピアへ 1 回ずつ問い合わせる。 */
export async function pollPeersOnce(timeoutMs: number, deps: PeerPollerDeps = {}): Promise<void> {
  const peers = listPeers().filter((peer) => peer.enabled);
  prunePeerStates(new Set(peers.map((peer) => peer.id)));
  await mapWithLimit(peers, PEER_POLL_CONCURRENCY, async (peer) => {
    const { outcome } = await probePeer(peer, timeoutMs, deps);
    if (!outcome.ok) {
      logger.debug({ peer: peer.name, status: outcome.status, error: outcome.error }, 'peer health poll failed');
    }
  });
}

export interface PeerPollerOptions {
  getCatalog: () => Catalog;
}

export function startPeerPoller(options: PeerPollerOptions, deps: PeerPollerDeps = {}): PeriodicTaskHandle {
  return startPeriodicTask({
    run: () => pollPeersOnce(federationSettings(options.getCatalog()).peerTimeoutMs, deps),
    intervalMs: () => federationSettings(options.getCatalog()).peerPollMs,
    onError: (err) => logger.warn({ err: (err as Error).message }, 'peer poll pass failed'),
  });
}
