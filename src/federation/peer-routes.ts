/**
 * ピア管理の HTTP 面 (loopback の本体にだけ載せる)。
 *
 *   /api/v1/peers                              ピア CRUD
 *   /api/v1/peers/:id/test                     疎通テスト (health を 1 回引き、 巡回キャッシュにも入れる)
 *   /api/v1/peers/:id/services/:code/control   ピアの 1 サービスを start / stop / restart (プロキシ)
 *   /api/v1/peers/:id/services/:code/update    ピアの 1 サービスを更新 (プロキシ)
 *
 * ピアの base_url は相手拠点の拠点間リスナー (Tailscale / Cloudflare Mesh 上のアドレス)。
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { createNamedLogger } from '../shared/logger.js';
import type { Catalog } from '../catalog/loader.js';
import { listPeers, getPeer, createPeer, updatePeer, deletePeer, markPeerResult, toView } from './store.js';
import { remoteControl, remoteUpdate } from './client.js';
import { probePeer } from './peer-probe.js';
import { federationSettings } from './settings.js';

/** @implements SPEC-FEDERATION-MESH */

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

/** ピア CRUD (自拠点の DB だけを触る。 相手拠点へは通信しない)。 */
export function buildPeerCrudRoutes(): Hono {
  const app = new Hono();

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

  return app;
}

/**
 * 相手拠点へ実際に通信する操作: 疎通テストと、 ピアの 1 サービスへの遠隔操作
 * (相手拠点の公開面 control / update へのプロキシ)。
 */
export function buildPeerActionRoutes(getCatalog: () => Catalog): Hono {
  const app = new Hono();

  // 疎通テスト: health を 1 回引き、 結果をキャッシュにも反映する (次の巡回を待たずに画面へ出る)。
  app.post('/api/v1/peers/:id/test', async (c) => {
    const peer = getPeer(c.req.param('id'));
    if (!peer) return c.json({ error: 'not_found' }, 404);
    const { outcome, httpStatus } = await probePeer(peer, federationSettings(getCatalog()).peerTimeoutMs);
    return c.json({
      ok: outcome.ok,
      status: httpStatus,
      link: outcome.status,
      latency_ms: outcome.latency_ms,
      error: outcome.error,
      node: outcome.payload?.node ?? null,
    });
  });

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
