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
    const result = acceptOperation(await c.req.json().catch(() => null), deps.getCatalog(), deps.runner, {
      requestedBy: caller.claimedNode ?? caller.peerName,
      requesterPeerId: caller.peerId,
    });
    return result.ok
      ? c.json({ operation: result.operation }, 202)
      : c.json({ error: result.error, detail: result.detail }, result.status);
  });

  app.get('/api/v1/federation/operations/:id', deps.auth, (c) => {
    const op = getOperation(c.req.param('id'));
    return op ? c.json({ operation: toDetail(op) }) : c.json({ error: 'not_found' }, 404);
  });

  return app;
}
