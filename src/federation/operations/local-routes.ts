/**
 * 自拠点への依頼の管理面 (loopback の本体にだけ載せる。 UI / MCP から自分の Excubitor に頼む)。
 *
 *   POST /api/v1/operations          依頼を受け付けて 202
 *   GET  /api/v1/operations          直近の依頼 (新しい順)
 *   GET  /api/v1/operations/:id      依頼の状態と手順
 *
 * 他拠点への依頼の中継は peer-operation-routes.ts。
 */

import { Hono } from 'hono';
import type { Catalog } from '../../catalog/loader.js';
import { acceptOperation } from './accept.js';
import type { OperationRunner } from './runner.js';
import { getOperation, listRecentOperations, toDetail, toSummary } from './store.js';

/** @implements SPEC-FEDERATION-OPERATIONS */

const LIST_LIMIT = 50;

export interface OperationLocalRoutesDeps {
  getCatalog: () => Catalog;
  runner: OperationRunner;
}

export function buildOperationLocalRoutes(deps: OperationLocalRoutesDeps): Hono {
  const app = new Hono();

  app.post('/api/v1/operations', async (c) => {
    const result = acceptOperation(await c.req.json().catch(() => null), deps.getCatalog(), deps.runner, {
      requestedBy: 'local',
      requesterPeerId: null,
    });
    return result.ok
      ? c.json({ operation: result.operation }, 202)
      : c.json({ error: result.error, detail: result.detail }, result.status);
  });

  app.get('/api/v1/operations', (c) => c.json({ operations: listRecentOperations(LIST_LIMIT).map(toSummary) }));

  app.get('/api/v1/operations/:id', (c) => {
    const op = getOperation(c.req.param('id'));
    return op ? c.json({ operation: toDetail(op) }) : c.json({ error: 'not_found' }, 404);
  });

  return app;
}
