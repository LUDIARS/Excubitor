import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { resolve } from 'node:path';
import { reportInput, serviceCode } from './schema.js';
import { SecurityReportStore } from './store.js';

/** Local management surface only; parent applies localBrowserGuard.
 * No probes, package installs, external lookups or service controls on report access.
 * @implements SPEC-EX-SECURITY-REPORTS */
export function buildSecurityReportsRouter(
  exists: (code: string) => boolean,
  store = new SecurityReportStore(resolve('data/security-reports')),
): Hono {
  const app = new Hono();
  const path = '/api/v1/services/:code/security-report';
  app.use(path, async (c, next) => {
    const code = c.req.param('code') ?? '';
    if (!serviceCode.safeParse(code).success) return c.json({ error: 'invalid_service' }, 400);
    if (!exists(code)) return c.json({ error: 'not_found' }, 404);
    c.header('Cache-Control', 'no-store');
    await next();
  });
  app.get(path, (c) => {
    try { return c.json({ report: store.latest(c.req.param('code')) }); }
    catch { return c.json({ error: 'report_read_failed' }, 500); }
  });
  app.post(path, bodyLimit({ maxSize: 1024 * 1024 }), async (c) => {
    const parsed = reportInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_report' }, 400);
    try { return c.json({ report: store.save(c.req.param('code'), parsed.data) }, 201); }
    catch { return c.json({ error: 'report_write_failed' }, 500); }
  });
  return app;
}
