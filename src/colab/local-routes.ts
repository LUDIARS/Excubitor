import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { EMPTY_BROWSER_ALLOWLIST, evaluateBrowserRequest } from '../security/browser-allowlist.js';
import type { RemotePeer } from '../federation/store.js';
import type { ColabSiteClient } from './client.js';
import { colabReceipt } from './journal.js';
import { collectSchema, jobId, MAX_REQUEST_BYTES, submitSchema } from './protocol.js';
import type { ColabRunner } from './runner.js';

function isLocalColabRequest(c: Context): boolean {
  if (['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'cf-connecting-ip', 'cf-access-jwt-assertion']
    .some(name => c.req.header(name) !== undefined)) return false;
  let address: string | undefined;
  try { address = getConnInfo(c).remote.address?.replace(/^::ffff:/, ''); }
  catch { return false; }
  if (address !== '127.0.0.1' && address !== '::1') return false;
  const url = new URL(c.req.url);
  return evaluateBrowserRequest({
    host: c.req.header('host') ?? url.host, protocol: url.protocol, origin: c.req.header('origin'),
    secFetchSite: c.req.header('sec-fetch-site'), allowlist: EMPTY_BROWSER_ALLOWLIST,
  }).ok;
}

interface Deps {
  runner: ColabRunner;
  sitePeerId?: string;
  findPeer: (id: string) => RemotePeer | null;
  client: ColabSiteClient;
  isLocal?: (context: Context) => boolean;
}

export function buildLocalColabRoutes(deps: Deps): Hono {
  const app = new Hono();
  const { runner, client } = deps;
  const isLocal = deps.isLocal ?? isLocalColabRequest;
  app.use('*', async (c, next) => {
    if (!isLocal(c)) return c.json({ error: 'colab_loopback_required' }, 403);
    await next();
  });
  app.use('*', bodyLimit({ maxSize: MAX_REQUEST_BYTES, onError: c => c.json({ error: 'colab_request_too_large' }, 413) }));

  app.get('/site', c => {
    const job = runner.active();
    return c.json({ enabled: runner.site?.enabled === true, ready: runner.lastReadiness, job: job ? colabReceipt(job) : null },
      200, { 'cache-control': 'no-store' });
  });
  app.post('/site/readiness', async c => c.json({ ready: await runner.ready() }, 200, { 'cache-control': 'no-store' }));
  app.post('/site/jobs/:id/cancel', c => {
    const id = jobId.safeParse(c.req.param('id'));
    const job = id.success && runner.cancel(id.data);
    return job ? c.json(colabReceipt(job)) : c.json({ error: 'colab_job_missing' }, 404);
  });

  const peer = (id: string): RemotePeer | null => {
    const registered = id === deps.sitePeerId ? deps.findPeer(id) : null;
    return registered?.enabled ? registered : null;
  };

  app.post('/peers/:site/jobs', async c => {
    const target = peer(c.req.param('site'));
    if (!target) return c.json({ error: 'colab_site_not_registered' }, 404);
    const request = submitSchema.safeParse(await c.req.json().catch(() => null));
    return request.success ? client.submit(target, request.data) : c.json({ error: 'colab_invalid_submit' }, 400);
  });

  app.get('/peers/:site/jobs/:id', c => {
    const target = peer(c.req.param('site'));
    if (!target) return c.json({ error: 'colab_site_not_registered' }, 404);
    const id = jobId.safeParse(c.req.param('id'));
    return id.success ? client.status(target, id.data) : c.json({ error: 'colab_job_missing' }, 404);
  });

  app.post('/peers/:site/jobs/:id/cancel', c => {
    const target = peer(c.req.param('site'));
    if (!target) return c.json({ error: 'colab_site_not_registered' }, 404);
    const id = jobId.safeParse(c.req.param('id'));
    return id.success ? client.cancel(target, id.data) : c.json({ error: 'colab_job_missing' }, 404);
  });

  app.post('/peers/:site/jobs/:id/collect', async c => {
    const target = peer(c.req.param('site'));
    if (!target) return c.json({ error: 'colab_site_not_registered' }, 404);
    const id = jobId.safeParse(c.req.param('id'));
    if (!id.success) return c.json({ error: 'colab_job_missing' }, 404);
    const request = collectSchema.safeParse(await c.req.json().catch(() => null));
    return request.success ? client.collect(target, id.data, request.data.name) : c.json({ error: 'colab_invalid_collect' }, 400);
  });
  return app;
}
