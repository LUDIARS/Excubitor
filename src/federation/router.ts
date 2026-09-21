/**
 * Federation API (`/api/v1/peers/*` + `/api/v1/federation/*`)。
 *
 * 2 つの面を持つ:
 *  1. ローカル管理 (loopback、 本ノードの UI / MCP が使う):
 *     - ピア CRUD (/api/v1/peers) と疎通テスト
 *     - メッシュ集約 (/api/v1/federation/mesh)     拠点・拠点間リンク・サービス × 拠点の担保表
 *     - 担保 (/api/v1/federation/coverage)          自拠点の担保一覧と拠点ごとの上書き
 *     - 集約ビュー (/api/v1/federation/services)   local + 全 enabled ピア (旧形式)
 *     - リモート操作プロキシ (/api/v1/peers/:id/services/:code/control|update)
 *     ピアの値はすべて peer-poller のキャッシュから返し、 画面を開くたびに他拠点へ問い合わせない。
 *  2. リモート公開 (public-router.ts): 他拠点が agent token 付きで叩く health / node / control / update。
 *     本体にも載せるが、 他拠点からはメッシュ側の拠点間リスナー (listener.ts) 経由で届く。
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { createNamedLogger } from '../shared/logger.js';
import type { Catalog } from '../catalog/loader.js';
import { getOrCreateAgentToken } from '../secrets/agent-token.js';
import {
  listPeers, getPeer, createPeer, updatePeer, deletePeer, markPeerResult, toView,
  listEnabledPeerIdentities, type RemotePeer,
} from './store.js';
import { fetchHealth, remoteControl, remoteUpdate } from './client.js';
import { buildFederationPublicRouter } from './public-router.js';
import { localNodeName, localNodeSnapshot } from './node-snapshot.js';
import { localHealthPayload } from './node-health.js';
import { buildMeshView } from './mesh-view.js';
import { getPeerState, pendingPeerState, recordPeerPoll, type PeerPollState } from './peer-cache.js';
import { classifyPeerResponse } from './peer-response.js';
import { federationSettings } from './settings.js';
import { setCoveragePref } from './coverage-prefs.js';
import type { FederationListenerStatus } from './listener.js';

const logger = createNamedLogger('excubitor.federation');

const CreatePeerSchema = z.object({
  name: z.string().min(1),
  base_url: z.string().url(),
  token: z.string().min(1),
  cf_access_id: z.string().optional(),
  cf_access_secret: z.string().optional(),
  enabled: z.boolean().optional(),
});

const UpdatePeerSchema = z.object({
  name: z.string().min(1).optional(),
  base_url: z.string().url().optional(),
  token: z.string().min(1).optional(),
  // 空文字は「クリア」を許可 (CF Access を外す)。
  cf_access_id: z.string().optional(),
  cf_access_secret: z.string().optional(),
  enabled: z.boolean().optional(),
});

const CoveragePrefSchema = z.object({
  /** true / false で上書き、 null で catalog の既定に戻す。 */
  covered: z.boolean().nullable(),
});

export interface FederationRouterOptions {
  getCatalog: () => Catalog;
  getListenerStatus: () => FederationListenerStatus;
}

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

export function buildFederationRouter(options: FederationRouterOptions): Hono {
  const { getCatalog } = options;
  const app = new Hono();

  // ─── リモート公開面 (Bearer token 認証、 public-router.ts) ─────
  app.route('/', buildFederationPublicRouter(getCatalog));

  // ─── ローカル管理面 ───────────────────────────────────────

  // 本ノード自身の identity (federation 名 + agent token + 拠点間リスナー)。
  // ピア登録には相手ノードに「こちらの token」と「メッシュ上の URL」を貼る必要があるため、
  // UI がコピー導線を出せるよう raw token を返す。 token は本ノードを操作できる機密なので、
  // これは loopback 管理面 (peer CRUD と同方針) でのみ提供する。
  app.get('/api/v1/federation/self', (c) => {
    const listener = options.getListenerStatus();
    return c.json({
      node: localNodeName(),
      token: getOrCreateAgentToken(),
      listener,
      mesh_base_urls: listener.listening.map((address) => `http://${address}`),
    });
  });

  app.get('/api/v1/peers', (c) => c.json({ peers: listPeers().map(toView) }));

  app.post('/api/v1/peers', async (c) => {
    const parsed = CreatePeerSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid_body', detail: parsed.error.flatten() }, 400);
    const peer = createPeer(parsed.data);
    logger.info({ id: peer.id, name: peer.name, base_url: peer.base_url }, 'peer added');
    return c.json({ ok: true, peer: toView(peer) }, 201);
  });

  app.patch('/api/v1/peers/:id', async (c) => {
    const parsed = UpdatePeerSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid_body', detail: parsed.error.flatten() }, 400);
    const peer = updatePeer(c.req.param('id'), parsed.data);
    if (!peer) return c.json({ error: 'not_found' }, 404);
    return c.json({ ok: true, peer: toView(peer) });
  });

  app.delete('/api/v1/peers/:id', (c) => {
    const ok = deletePeer(c.req.param('id'));
    return ok ? c.json({ ok: true }) : c.json({ error: 'not_found' }, 404);
  });

  // ピア疎通テスト: health を 1 回引き、 結果をキャッシュにも反映する (次の巡回を待たずに画面へ出る)。
  app.post('/api/v1/peers/:id/test', async (c) => {
    const peer = getPeer(c.req.param('id'));
    if (!peer) return c.json({ error: 'not_found' }, 404);
    const startedAt = Date.now();
    const res = await fetchHealth(peer, federationSettings(getCatalog()).peerTimeoutMs);
    const outcome = classifyPeerResponse(res, Date.now() - startedAt);
    recordPeerPoll(peer, outcome, Date.now());
    markPeerResult(peer.id, outcome.ok, outcome.error);
    return c.json({
      ok: outcome.ok,
      status: res.status,
      link: outcome.status,
      latency_ms: outcome.latency_ms,
      error: outcome.error,
      node: outcome.payload?.node ?? null,
    });
  });

  // ─── メッシュ集約: 拠点 / 拠点間リンク / サービス × 拠点の担保 ─────
  app.get('/api/v1/federation/mesh', (c) => {
    const catalog = getCatalog();
    return c.json(buildMeshView({
      now: Date.now(),
      staleAfterMs: federationSettings(catalog).staleAfterMs,
      self: localHealthPayload(catalog),
      peers: enabledPeerStates(),
    }));
  });

  // ─── 自拠点の担保一覧 + 拠点ごとの上書き ───────────────────
  app.get('/api/v1/federation/coverage', (c) => {
    const payload = localHealthPayload(getCatalog());
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

  // ─── 集約ビュー (旧形式): local + 全 enabled ピア。 ピア分はキャッシュから ─────
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

  // ─── リモート操作プロキシ ───────────────────────────────────
  app.post('/api/v1/peers/:id/services/:code/control', async (c) => {
    const peer = getPeer(c.req.param('id'));
    if (!peer) return c.json({ error: 'peer_not_found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { action?: 'start' | 'stop' | 'restart' };
    if (!body.action || !['start', 'stop', 'restart'].includes(body.action)) {
      return c.json({ error: 'invalid_action' }, 400);
    }
    const res = await remoteControl(peer, c.req.param('code'), body.action);
    markPeerResult(peer.id, res.ok, res.error);
    return c.json({ ok: res.ok, status: res.status, error: res.error, result: res.data }, res.ok ? 200 : 502);
  });

  app.post('/api/v1/peers/:id/services/:code/update', async (c) => {
    const peer = getPeer(c.req.param('id'));
    if (!peer) return c.json({ error: 'peer_not_found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { install?: boolean; restart?: boolean };
    const res = await remoteUpdate(peer, c.req.param('code'), body);
    markPeerResult(peer.id, res.ok, res.error);
    return c.json({ ok: res.ok, status: res.status, error: res.error, result: res.data }, res.ok ? 200 : 502);
  });

  return app;
}

// re-export for callers/tests
export type { RemotePeer };
