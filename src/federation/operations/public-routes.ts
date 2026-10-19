/**
 * 他拠点から受ける依頼の公開面 (相互登録済みのピアだけ。 認可は peer-auth.ts)。
 *
 *   POST /api/v1/federation/operations        依頼を受け付けて 202 (実行は runner が順番に)
 *   GET  /api/v1/federation/operations/:id    依頼の状態と手順
 */

import { Hono, type MiddlewareHandler } from 'hono';
import type { Catalog } from '../../catalog/loader.js';
import type { FederationEnv } from '../peer-auth.js';
import { acceptOperation } from './accept.js';
import type { OperationRunner } from './runner.js';
import { getOperation, toDetail } from './store.js';
import { OperationRequestSchema } from './types.js';
import { permitsMeshAction } from '../security/grants.js';
import { operationScope } from '../security/operation-scope.js';
import { requestDigest } from './reauthorize-queued.js';

/** @implements SPEC-FEDERATION-OPERATIONS */

export interface OperationPublicRoutesDeps {
  getCatalog: () => Catalog;
  runner: OperationRunner;
  auth: MiddlewareHandler<FederationEnv>;
}

export function buildOperationPublicRoutes(deps: OperationPublicRoutesDeps): Hono<FederationEnv> {
  const app = new Hono<FederationEnv>();

  app.post('/api/v1/federation/operations', deps.auth, async (c) => {
    const caller = c.get('federationCaller');
    // The digest of the exact body binds a later reauthorization to this request (same scope).
    const raw = await c.req.text();
    let json: unknown = null;
    try { json = JSON.parse(raw); } catch { /* invalid_body below */ }
    const parsed = OperationRequestSchema.safeParse(json);
    if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
    const { action, resource } = operationScope(parsed.data);
    if (!permitsMeshAction({ caller, action, resource })) return c.json({ error: 'operation_grant_required' }, 403);
    const result = await acceptOperation(parsed.data, deps.getCatalog(), deps.runner, {
      requestedBy: caller.subject ?? caller.peerName,
      requesterPeerId: caller.peerId,
      requestDigest: requestDigest(raw),
      permit: {
        expiresAt: caller.expiresAt ?? 0,
        authorize: async () => caller.reauthorize !== undefined && permitsMeshAction({ caller: await caller.reauthorize(), action, resource }),
      },
    });
    return result.ok
      ? c.json({ operation: result.operation }, 202)
      : c.json({ error: result.error, detail: result.detail }, result.status);
  });

  app.get('/api/v1/federation/operations/:id', deps.auth, (c) => {
    const caller = c.get('federationCaller');
    if (!permitsMeshAction({ caller, action: 'monitor', resource: `node:${caller.audience}` })) return c.json({ error: 'forbidden' }, 403);
    const op = getOperation(c.req.param('id'));
    return op && op.requester_peer_id === caller.peerId ? c.json({ operation: toDetail(op) }) : c.json({ error: 'not_found' }, 404);
  });

  return app;
}
