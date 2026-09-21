/**
 * 拠点メッシュの閲覧・担保設定の HTTP 面 (loopback の本体にだけ載せる)。
 *
 *   GET /api/v1/federation/self             拠点名 + agent token + 拠点間リスナーの状態と URL
 *   GET /api/v1/federation/mesh             拠点 / 拠点間リンク / サービス × 拠点の担保表
 *   GET /api/v1/federation/coverage         自拠点の担保一覧 (死活付き)
 *   PUT /api/v1/federation/coverage/:code   自拠点での担保の上書き
 *   GET /api/v1/federation/services         local + ピアの集約 (旧形式)
 *
 * ピアの値はすべて peer-poller のキャッシュから返し、 開くたびに他拠点へ問い合わせない。
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { createNamedLogger } from '../shared/logger.js';
import type { Catalog } from '../catalog/loader.js';
import { getOrCreateAgentToken } from '../secrets/agent-token.js';
import { listPeers, listEnabledPeerIdentities, type RemotePeer } from './store.js';
import { localNodeName, localNodeSnapshot } from './node-snapshot.js';
import { localHealthPayload } from './node-health.js';
import { buildMeshView } from './mesh-view.js';
import { getPeerState, pendingPeerState, type PeerPollState } from './peer-cache.js';
import { federationSettings } from './settings.js';
import { setCoveragePref } from './coverage-prefs.js';
import type { FederationListenerStatus } from './listener.js';

/** @implements SPEC-FEDERATION-COVERAGE */

const logger = createNamedLogger('excubitor.federation');

const CoveragePrefSchema = z.object({
  /** true / false で上書き、 null で catalog の既定に戻す。 */
  covered: z.boolean().nullable(),
});

/** 有効な各ピアのキャッシュ状態 (まだ問い合わせていなければ pending)。 */
function enabledPeerStates(): PeerPollState[] {
  return listEnabledPeerIdentities().map((peer) => getPeerState(peer.id) ?? pendingPeerState(peer));
}

/** キャッシュ済みのピア状態を旧形式の集約ノードへ写す (UI / MCP の互換用)。 */
function legacyNodeView(peer: RemotePeer | undefined, state: PeerPollState, staleMs: number, now: number) {
  const payload = state.payload;
  return {
    peer_id: state.peer_id,
    name: state.name,
    base_url: peer?.base_url ?? null,
    ok: state.status === 'up',
    error: state.error,
    status: state.status,
    checked_at: state.checked_at,
    stale: state.payload_received_at == null || now - state.payload_received_at > staleMs,
    node: payload?.node ?? state.name,
    summary: payload?.summary ?? null,
    services: (payload?.services ?? []).map((svc) => ({
      code: svc.code,
      name: svc.name,
      state: svc.state,
      port: svc.port,
      git_branch: svc.git_branch,
      covered: svc.covered,
      kind: svc.kind,
    })),
    host: payload?.host ?? null,
  };
}

/**
 * 本拠点の identity (federation 名 + agent token + 拠点間リスナー)。
 * ピア登録には相手拠点に「こちらの token」と「メッシュ上の URL」を貼る必要があるので raw token を返す。
 * token は本拠点を操作できる機密なので、 loopback の本体にだけ載せる (拠点間リスナーには載せない)。
 */
export function buildSelfRoutes(getListenerStatus: () => FederationListenerStatus): Hono {
  const app = new Hono();
  app.get('/api/v1/federation/self', (c) => {
    const listener = getListenerStatus();
    return c.json({
      node: localNodeName(),
      token: getOrCreateAgentToken(),
      listener,
      mesh_base_urls: listener.listening.map((address) => `http://${address}`),
    });
  });
  return app;
}

/** メッシュ集約・担保・旧形式の集約ビュー。 */
export function buildMeshRoutes(
  getCatalog: () => Catalog,
  getListenerStatus: () => FederationListenerStatus,
): Hono {
  const app = new Hono();

  app.get('/api/v1/federation/mesh', (c) => {
    const catalog = getCatalog();
    return c.json(buildMeshView({
      now: Date.now(),
      staleAfterMs: federationSettings(catalog).staleAfterMs,
      self: localHealthPayload(catalog, getListenerStatus()),
      peers: enabledPeerStates(),
    }));
  });

  app.get('/api/v1/federation/coverage', (c) => {
    const payload = localHealthPayload(getCatalog(), getListenerStatus());
    return c.json({ node: payload.node, scan: payload.scan, services: payload.services });
  });

  app.put('/api/v1/federation/coverage/:code', async (c) => {
    const code = c.req.param('code');
    if (!getCatalog().services.some((svc) => svc.code === code)) return c.json({ error: 'not_found' }, 404);
    const parsed = CoveragePrefSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid_body', detail: parsed.error.flatten() }, 400);
    setCoveragePref(code, parsed.data.covered);
    logger.info({ code, covered: parsed.data.covered }, 'federation coverage override updated');
    return c.json({ ok: true, code, covered: parsed.data.covered });
  });

  app.get('/api/v1/federation/services', (c) => {
    const self = localNodeSnapshot();
    const now = Date.now();
    const staleMs = federationSettings(getCatalog()).staleAfterMs;
    const peersById = new Map(listPeers().map((peer) => [peer.id, peer]));
    return c.json({
      local: { peer_id: null, name: self.node, base_url: null, ok: true, error: null, ...self },
      peers: enabledPeerStates().map((state) => legacyNodeView(peersById.get(state.peer_id), state, staleMs, now)),
    });
  });

  return app;
}
