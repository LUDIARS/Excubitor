import { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Catalog } from '../catalog/loader.js';
import { readVillaDocument } from '../villa/documents.js';
import { viewerEntries, viewerTarget } from './catalog.js';
import { proxyViewer } from './proxy.js';
import { rewriteHtml } from './rewrite.js';

export function buildViewerRouter(getCatalog: () => Catalog, getCorpusPrefs: () => Map<string, boolean>): Hono {
  const app = new Hono();
  app.get('/api/v1/viewer/services', (c) => c.json({ services: viewerEntries(getCatalog(), getCorpusPrefs()) }));
  app.get('/viewer', (c) => c.redirect('/viewer/', 308));
  app.get('/viewer/', async (c) => {
    try {
      return c.html(await readFile(resolve('frontend/dist/index.html'), 'utf8'));
    } catch { return c.text('Viewerのフロントエンドをビルドしてください。', 503); }
  });
  app.get('/viewer/:script', async (c) => {
    const script = c.req.param('script');
    if (!['runtime.js', 'storage.js'].includes(script)) return c.notFound();
    c.header('content-type', 'text/javascript; charset=utf-8');
    c.header('cache-control', 'no-store');
    return c.body(await readFile(resolve('frontend/dist/viewer', script), 'utf8'));
  });
  app.get('/villa', (c) => c.redirect('/villa/', 308));
  app.get('/villa/*', (c) => c.redirect('/viewer/apps/villa/' + c.req.path.slice('/villa/'.length)
    + new URL(c.req.url).search, 308));
  app.all('/viewer/apps/:code', (c) => c.redirect(c.req.path + '/' + new URL(c.req.url).search, 308));
  app.all('/viewer/apps/:code/*', async (c) => {
    const code = c.req.param('code');
    if (code === 'villa') {
      if (!['GET', 'HEAD'].includes(c.req.method)) return c.text('Method not allowed', 405);
      try {
        const prefix = '/viewer/apps/villa';
        const path = c.req.path.slice(prefix.length);
        const html = await readVillaDocument(resolve('villa'), path);
        if (html === null) return c.notFound();
        const headers = new Headers({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        const target = { code, prefix, upstream: new URL('http://villa.invalid/'), origins: {} };
        const body = rewriteHtml(html, target, headers);
        return new Response(c.req.method === 'HEAD' ? null : body, { headers });
      } catch { return c.text('Villaの資料またはURL対応表を読み込めません。', 503); }
    }
    const target = viewerTarget(getCatalog(), getCorpusPrefs(), code);
    if (!target) return c.text('このサービスはViewerの対象外、またはWeb入口が未登録です。', 404);
    return proxyViewer(c, target);
  });
  return app;
}
