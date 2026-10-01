/**
 * CF Tunnel ルート管理 API (`/api/v1/cf-tunnel/*`)。
 *
 * セッション側 (MCP tool) はここを叩くだけで、CF トークンには触れない。
 *   GET  /api/v1/cf-tunnel/routes          … ingress 一覧 (?tunnel=<id|name>)
 *   POST /api/v1/cf-tunnel/routes          … 追加 {tunnel?, hostname, service, path?, require_access?}
 *   POST /api/v1/cf-tunnel/routes/remove   … 削除 {tunnel?, hostname, path?}
 * 変更は allowlist (EXCUBITOR_CF_TUNNEL_ALLOWED_HOSTNAMES → 無ければ config store の
 * cfTunnel.allowedHostnames) の hostname のみ (route-service.ts)。
 * Access アプリ・DNS は access-router.ts。
 *
 * @implements SPEC-CF-TUNNEL-ROUTES (spec/feature/cf-tunnel-routes.md)
 */

import { Hono } from 'hono';
import { createNamedLogger } from '../shared/logger.js';
import { accessIdentity, accessOriginRequest, findAppForHostname } from './access-service.js';
import { currentAllowlist, failureStatus, resolveTunnel } from './broker-support.js';
import { CloudflareAccessApi } from './cloudflare-access-api.js';
import { CloudflareTunnelApi } from './cloudflare-api.js';
import { resolveCfCredentials, type CfCredentials } from './credentials.js';
import { addRoute, describeRoutes, removeRoute, RouteRejectedError } from './route-service.js';

const logger = createNamedLogger('excubitor.cf-tunnel.router');

/**
 * Access 必須 route の originRequest。hostname の Access アプリが先に作られている必要がある
 * (無ければ入力拒否: 先に POST /api/v1/cf-access/apps)。
 */
async function requiredAccessOrigin(creds: CfCredentials, hostname: string): Promise<Record<string, unknown>> {
  const access = new CloudflareAccessApi(creds);
  const app = findAppForHostname(await access.listApps(), hostname);
  if (!app) {
    throw new RouteRejectedError(`hostname "${hostname}" の Access アプリが無い。先に POST /api/v1/cf-access/apps で作る`);
  }
  return accessOriginRequest(accessIdentity(await access.authDomain(), app));
}

/** @implements SPEC-CF-TUNNEL-ROUTES */
export function buildCfTunnelRouter(): Hono {
  const app = new Hono();

  app.get('/api/v1/cf-tunnel/routes', async (c) => {
    try {
      const api = new CloudflareTunnelApi(await resolveCfCredentials());
      const tunnel = await resolveTunnel(api, c.req.query('tunnel'));
      const config = await api.getConfiguration(tunnel.id);
      const allowed = currentAllowlist();
      return c.json({
        tunnel: { id: tunnel.id, name: tunnel.name },
        allowed_hostnames: allowed,
        routes: describeRoutes(config.ingress ?? [], allowed),
      });
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'cf-tunnel routes list failed');
      return c.json({ error: 'cf_tunnel_list_failed', message: (err as Error).message }, 502);
    }
  });

  app.post('/api/v1/cf-tunnel/routes', async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      tunnel?: string;
      hostname?: string;
      service?: string;
      path?: string;
      require_access?: boolean;
    } | null;
    if (!body?.hostname || !body?.service) {
      return c.json({ error: 'bad_request', message: 'hostname と service は必須' }, 400);
    }
    try {
      const creds = await resolveCfCredentials();
      const api = new CloudflareTunnelApi(creds);
      const tunnel = await resolveTunnel(api, body.tunnel);
      const config = await api.getConfiguration(tunnel.id);
      const allowed = currentAllowlist();
      const originRequest = body.require_access === true ? await requiredAccessOrigin(creds, body.hostname) : undefined;
      const ingress = addRoute(
        config.ingress ?? [],
        { hostname: body.hostname, service: body.service, path: body.path, originRequest },
        allowed,
      );
      const updated = await api.putConfiguration(tunnel.id, { ...config, ingress });
      logger.info(
        { tunnel: tunnel.name, hostname: body.hostname, path: body.path ?? null, requireAccess: Boolean(originRequest) },
        'cf-tunnel route added',
      );
      return c.json({
        ok: true,
        tunnel: { id: tunnel.id, name: tunnel.name },
        require_access: Boolean(originRequest),
        routes: describeRoutes(updated.ingress ?? ingress, allowed),
      });
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'cf-tunnel route add failed');
      return c.json(
        { error: 'cf_tunnel_add_failed', message: (err as Error).message },
        failureStatus(err),
      );
    }
  });

  app.post('/api/v1/cf-tunnel/routes/remove', async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      tunnel?: string;
      hostname?: string;
      path?: string;
    } | null;
    if (!body?.hostname) {
      return c.json({ error: 'bad_request', message: 'hostname は必須' }, 400);
    }
    try {
      const api = new CloudflareTunnelApi(await resolveCfCredentials());
      const tunnel = await resolveTunnel(api, body.tunnel);
      const config = await api.getConfiguration(tunnel.id);
      const allowed = currentAllowlist();
      const ingress = removeRoute(config.ingress ?? [], { hostname: body.hostname, path: body.path }, allowed);
      const updated = await api.putConfiguration(tunnel.id, { ...config, ingress });
      logger.info(
        { tunnel: tunnel.name, hostname: body.hostname, path: body.path ?? null },
        'cf-tunnel route removed',
      );
      return c.json({
        ok: true,
        tunnel: { id: tunnel.id, name: tunnel.name },
        routes: describeRoutes(updated.ingress ?? ingress, allowed),
      });
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'cf-tunnel route remove failed');
      return c.json(
        { error: 'cf_tunnel_remove_failed', message: (err as Error).message },
        failureStatus(err),
      );
    }
  });

  return app;
}
