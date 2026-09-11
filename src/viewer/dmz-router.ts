import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import type { ViewerDirectory } from './manifest.js';
import { buildViewerRouter } from './router.js';

/** This router cannot import or mount management, secret-agent, MCP or control APIs. */
export function buildDmzRouter(directory: ViewerDirectory): Hono {
  const app = new Hono();
  app.onError((_error, c) => c.text('Viewerの公開対象一覧を取得できません。', 503));
  app.get('/health', (c) => {
    directory.entries();
    return c.json({ ok: true, component: 'viewer-dmz' });
  });
  app.get('/', (c) => c.redirect('/viewer/' + new URL(c.req.url).search, 308));
  app.route('/', buildViewerRouter(directory));
  // Only the separate DMZ entries are served, never the management App build.
  app.get('/assets/*', serveStatic({ root: './frontend/dist-dmz' }));
  app.notFound((c) => c.text('Not found', 404));
  return app;
}
