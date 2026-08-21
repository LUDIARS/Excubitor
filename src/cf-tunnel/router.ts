/**
 * CF Tunnel ルート管理 API (`/api/v1/cf-tunnel/*`)。
 *
 * セッション側 (MCP tool) はここを叩くだけで、CF トークンには触れない。
 *   GET  /api/v1/cf-tunnel/routes          … ingress 一覧 (?tunnel=<id|name>)
 *   POST /api/v1/cf-tunnel/routes          … 追加 {tunnel?, hostname, service, path?}
 *   POST /api/v1/cf-tunnel/routes/remove   … 削除 {tunnel?, hostname, path?}
 * 変更は allowlist (EXCUBITOR_CF_TUNNEL_ALLOWED_HOSTNAMES → 無ければ config store の
 * cfTunnel.allowedHostnames) の hostname のみ (route-service.ts)。
 *
 * @implements SPEC-CF-TUNNEL-ROUTES (spec/feature/cf-tunnel-routes.md)
 */

import { Hono } from 'hono';
import { createNamedLogger } from '../shared/logger.js';
import { CloudflareTunnelApi, type CfTunnelSummary } from './cloudflare-api.js';
import { resolveCfCredentials } from './credentials.js';
import { getCfTunnelSettings } from '../secrets/config-store.js';
import {
  addRoute,
  describeRoutes,
  readAllowedHostnames,
  removeRoute,
  RouteRejectedError,
} from './route-service.js';

const logger = createNamedLogger('excubitor.cf-tunnel.router');

/** 入力拒否 (allowlist 外・重複等) は 400、CF 側の失敗は 502 に振り分ける。 */
function failureStatus(err: unknown): 400 | 502 {
  return err instanceof RouteRejectedError ? 400 : 502;
}

/** @implements SPEC-CF-TUNNEL-ROUTES */
async function buildApi(): Promise<CloudflareTunnelApi> {
  return new CloudflareTunnelApi(await resolveCfCredentials());
}

/** allowlist の解決 (env 優先 → config store)。 @implements SPEC-CF-TUNNEL-ROUTES */
function currentAllowlist(): string[] {
  return readAllowedHostnames(process.env, getCfTunnelSettings().allowedHostnames ?? []);
}

/**
 * tunnel パラメータ (id か name) を解決。未指定はアカウント唯一の tunnel に限り許す。
 *
 * 見つからない場合もアカウント内の tunnel 名は列挙しない: 呼び出し側 (AI セッション) は
 * allowlist 経由の狭い操作しか許されておらず、無関係な tunnel の存在自体が
 * インフラ構成の漏洩になる (§14 トークン境界と同じ理由)。件数だけ返す。
 */
async function resolveTunnel(
  api: CloudflareTunnelApi,
  param: string | undefined,
): Promise<CfTunnelSummary> {
  const tunnels = await api.listTunnels();
  if (param) {
    const found = tunnels.find((t) => t.id === param || t.name === param);
    if (!found) {
      throw new Error(`tunnel "${param}" が見つからない (アカウント内 ${tunnels.length} 件と不一致)`);
    }
    return found;
  }
  if (tunnels.length === 1 && tunnels[0]) return tunnels[0];
  throw new Error(
    `tunnel を指定してください (tunnel=<id|name>)。アカウント内の tunnel は ${tunnels.length} 件`,
  );
}

/** @implements SPEC-CF-TUNNEL-ROUTES */
export function buildCfTunnelRouter(): Hono {
  const app = new Hono();

  app.get('/api/v1/cf-tunnel/routes', async (c) => {
    try {
      const api = await buildApi();
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
    } | null;
    if (!body?.hostname || !body?.service) {
      return c.json({ error: 'bad_request', message: 'hostname と service は必須' }, 400);
    }
    try {
      const api = await buildApi();
      const tunnel = await resolveTunnel(api, body.tunnel);
      const config = await api.getConfiguration(tunnel.id);
      const allowed = currentAllowlist();
      const ingress = addRoute(
        config.ingress ?? [],
        { hostname: body.hostname, service: body.service, path: body.path },
        allowed,
      );
      const updated = await api.putConfiguration(tunnel.id, { ...config, ingress });
      logger.info(
        { tunnel: tunnel.name, hostname: body.hostname, path: body.path ?? null },
        'cf-tunnel route added',
      );
      return c.json({
        ok: true,
        tunnel: { id: tunnel.id, name: tunnel.name },
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
      const api = await buildApi();
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
