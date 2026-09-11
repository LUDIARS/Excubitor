import { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ViewerDirectory } from './manifest.js';
import { readVillaDocument } from '../villa/documents.js';
import { proxyViewer } from './proxy.js';
import { rewriteHtml } from './rewrite.js';

export function buildViewerRouter(directory: ViewerDirectory): Hono {
  const app = new Hono();
  app.get('/api/v1/viewer/services', (c) => c.json({ services: directory.entries() }));
  app.get('/viewer', (c) => c.redirect('/viewer/', 308));
  app.get('/viewer/', async (c) => {
    try {
      return c.html(await readFile(resolve('frontend/dist-dmz/index.html'), 'utf8'));
    } catch { return c.text('Viewerのフロントエンドをビルドしてください。', 503); }
  });
  app.get('/viewer/:script', async (c) => {
    const script = c.req.param('script');
    if (!['runtime.js', 'storage.js'].includes(script)) return c.notFound();
    c.header('content-type', 'text/javascript; charset=utf-8');
    c.header('cache-control', 'no-store');
    return c.body(await readFile(resolve('frontend/dist-dmz/viewer', script), 'utf8'));
  });
  app.get('/villa', (c) => c.redirect('/villa/', 308));
  app.get('/villa/*', (c) => c.redirect('/viewer/apps/villa/' + c.req.path.slice('/villa/'.length)
    + new URL(c.req.url).search, 308));
  app.all('/viewer/apps/:code', (c) => c.redirect(c.req.path + '/' + new URL(c.req.url).search, 308));
  app.all('/viewer/apps/:code/*', async (c) => {
    directory.entries(); // Villa also fails closed when the publication lease expires.
    const code = c.req.param('code');
    if (code === 'excubitor') {
      if (!['GET', 'HEAD'].includes(c.req.method)) return c.text('Method not allowed', 405);
      const snapshot = directory.monitor?.();
      if (!snapshot) return c.text('Monitorの表示情報を取得できません。', 503);
      c.header('cache-control', 'no-store');
      if (c.req.path === '/viewer/apps/excubitor/snapshot') return c.json(snapshot);
      if (c.req.path !== '/viewer/apps/excubitor/') return c.notFound();
      return c.html(await readFile(resolve('frontend/dist-dmz/monitor.html'), 'utf8'));
    }
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
    const target = directory.target(code);
    if (!target) return c.text('このサービスはViewerの対象外、またはWeb入口が未登録です。', 404);
    return proxyViewer(c, target);
  });
  return app;
}
