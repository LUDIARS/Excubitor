/**
 * アップデート API (`/api/v1/updates` + `/api/v1/services/:code/update`)。
 *
 * - GET  /api/v1/updates?fetch=1        全サービスのアップデート状態 (fetch=1 で origin 取得)
 * - GET  /api/v1/services/:code/update  単一サービスの状態 (常に fetch)
 * - POST /api/v1/services/:code/update  アップデート適用 (pull + install + restart)
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { Catalog } from '../catalog/loader.js';
import { checkAllUpdates, checkUpdate } from './checker.js';
import { applyUpdate } from './apply.js';

const ApplyBodySchema = z.object({
  install: z.boolean().optional(),
  restart: z.boolean().optional(),
});

export function buildUpdateRouter(getCatalog: () => Catalog): Hono {
  const app = new Hono();

  app.get('/api/v1/updates', async (c) => {
    const fetch = c.req.query('fetch') === '1';
    const updates = await checkAllUpdates(getCatalog(), fetch);
    return c.json({ updates, fetched: fetch });
  });

  app.get('/api/v1/services/:code/update', async (c) => {
    const code = c.req.param('code');
    const svc = getCatalog().services.find((s) => s.code === code);
    if (!svc) return c.json({ error: 'not_found' }, 404);
    const status = await checkUpdate(svc, true);
    return c.json(status);
  });

  app.post('/api/v1/services/:code/update', async (c) => {
    const code = c.req.param('code');
    const svc = getCatalog().services.find((s) => s.code === code);
    if (!svc) return c.json({ error: 'not_found' }, 404);
    const body = await c.req.json().catch(() => ({}));
    const parsed = ApplyBodySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
    const actor = c.req.header('x-excubitor-actor') ?? 'launcher';
    const result = await applyUpdate(svc, actor, parsed.data);
    return c.json(result, result.ok ? 200 : 400);
  });

  return app;
}
