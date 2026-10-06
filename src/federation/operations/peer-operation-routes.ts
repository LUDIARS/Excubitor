/**
 * 他拠点への依頼の中継 (loopback の本体にだけ載せる)。 相手の公開面へ署名付きで送る。
 *
 *   POST /api/v1/peers/:id/operations          依頼を出す
 *   GET  /api/v1/peers/:id/operations/:opId    依頼の状態を相手に聞く (UI が見ている間だけの能動取得)
 *
 * 相手の応答コード (202 / 400 / 404 / 409 / 403 相互登録待ち 等) はそのまま返し、届かなかったときは 502。
 *
 * update / deploy には、 本拠点の catalog にある repo を bootstrap 指定として添える。 相手の拠点に
 * そのサービスがまだ無ければ、 相手はこれを bootstrap として受ける (2026-10-06 neco: 本社→他拠点デプロイはすべて許可)。
 */

import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { fetchOperation, requestOperation, type PeerCallResult } from '../client.js';
import { getPeer } from '../store.js';
import type { Catalog } from '../../catalog/loader.js';
import { BootstrapRepositorySchema } from '../../bootstrap/repository.js';
import { OperationRequestSchema, type OperationRequest } from './types.js';

/** @implements SPEC-FEDERATION-OPERATIONS */

function relay(c: Context, res: PeerCallResult<unknown>): Response {
  if (res.ok) return c.json(res.data, (res.status ?? 200) as ContentfulStatusCode);
  const status = res.status && res.status < 500 ? res.status : 502;
  return c.json({ error: res.error, peer_status: res.status, peer_body: res.data }, status as ContentfulStatusCode);
}

/** update / deploy に本拠点 catalog の repo を bootstrap 指定として添える (pure)。 添えられなければそのまま返す。 */
export function withBootstrapFallback(request: OperationRequest, catalog: Pick<Catalog, 'services'> | null): OperationRequest {
  if (request.bootstrap || (request.action !== 'update' && request.action !== 'deploy')) return request;
  if (request.target.kind !== 'service' || !catalog) return request;
  const code = request.target.code;
  const repo = catalog.services.find((s) => s.code === code)?.repo;
  if (!repo || !BootstrapRepositorySchema.safeParse(repo).success) return request;
  return { ...request, bootstrap: { repository: repo, start: request.action === 'deploy' } };
}

export function buildPeerOperationRoutes(getCatalog: (() => Catalog) | null = null): Hono {
  const app = new Hono();

  app.post('/api/v1/peers/:id/operations', async (c) => {
    const peer = getPeer(c.req.param('id'));
    if (!peer) return c.json({ error: 'peer_not_found' }, 404);
    const parsed = OperationRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_body', detail: parsed.error.flatten() }, 400);
    const request = withBootstrapFallback(parsed.data, getCatalog?.() ?? null);
    let res = await requestOperation(peer, request);
    // 更新前の拠点は update / deploy に添えた bootstrap 指定を 400 で断る。 そのときは添えずに送り直す。
    if (request !== parsed.data && !res.ok && res.status === 400) res = await requestOperation(peer, parsed.data);
    return relay(c, res);
  });

  app.get('/api/v1/peers/:id/operations/:opId', async (c) => {
    const peer = getPeer(c.req.param('id'));
    if (!peer) return c.json({ error: 'peer_not_found' }, 404);
    return relay(c, await fetchOperation(peer, c.req.param('opId')));
  });

  return app;
}
