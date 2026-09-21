/**
 * 他拠点への依頼の中継 (loopback の本体にだけ載せる)。 相手の公開面へ署名付きで送る。
 *
 *   POST /api/v1/peers/:id/operations          依頼を出す
 *   GET  /api/v1/peers/:id/operations/:opId    依頼の状態を相手に聞く (UI が見ている間だけの能動取得)
 *
 * 相手の応答コード (202 / 400 / 404 / 409 / 403 相互登録待ち 等) はそのまま返し、届かなかったときは 502。
 */

import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { fetchOperation, requestOperation, type PeerCallResult } from '../client.js';
import { getPeer } from '../store.js';
import { OperationRequestSchema } from './types.js';

/** @implements SPEC-FEDERATION-OPERATIONS */

function relay(c: Context, res: PeerCallResult<unknown>): Response {
  if (res.ok) return c.json(res.data, (res.status ?? 200) as ContentfulStatusCode);
  const status = res.status && res.status < 500 ? res.status : 502;
  return c.json({ error: res.error, peer_status: res.status, peer_body: res.data }, status as ContentfulStatusCode);
}

export function buildPeerOperationRoutes(): Hono {
  const app = new Hono();

  app.post('/api/v1/peers/:id/operations', async (c) => {
    const peer = getPeer(c.req.param('id'));
    if (!peer) return c.json({ error: 'peer_not_found' }, 404);
    const parsed = OperationRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_body', detail: parsed.error.flatten() }, 400);
    return relay(c, await requestOperation(peer, parsed.data));
  });

  app.get('/api/v1/peers/:id/operations/:opId', async (c) => {
    const peer = getPeer(c.req.param('id'));
    if (!peer) return c.json({ error: 'peer_not_found' }, 404);
    return relay(c, await fetchOperation(peer, c.req.param('opId')));
  });

  return app;
}
