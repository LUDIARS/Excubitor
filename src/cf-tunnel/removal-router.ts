/**
 * CF ブローカーの削除 API。トークンは cf-tunnel と同じく Excubitor 内だけ。
 *   POST /api/v1/cf-tunnel/dns/remove      … {hostname, tunnel?}
 *        hostname の CNAME のうち、tunnel (`<id>.cfargotunnel.com`) を向いたものだけを消す。
 *   POST /api/v1/cf-tunnel/tunnels/remove  … {tunnel, confirm}
 *        confirm = tunnel 名、hostname 付きルート 0 件、cloudflared 未接続のときだけ消す。
 * DNS は allowlist の hostname のみ。既に無ければ removed: false で成功 (冪等)。
 * Access アプリの削除は access-router.ts の POST /api/v1/cf-access/apps/remove。
 *
 * @implements SPEC-CF-TUNNEL-ROUTES (spec/feature/cf-tunnel-routes.md)
 */

import { Hono } from 'hono';
import { createNamedLogger } from '../shared/logger.js';
import { zoneCandidates } from './access-service.js';
import { currentAllowlist, failureStatus, resolveTunnel } from './broker-support.js';
import { CloudflareTunnelApi } from './cloudflare-api.js';
import { CloudflareDnsApi } from './cloudflare-dns-api.js';
import { resolveCfCredentials } from './credentials.js';
import { assertTunnelDeletable, planTunnelCnameRemoval } from './removal-service.js';
import { isHostnameAllowed, RouteRejectedError } from './route-service.js';

const logger = createNamedLogger('excubitor.cf-tunnel.removal-router');

function allowedHostname(raw: string): string {
  const hostname = raw.trim().toLowerCase();
  if (!isHostnameAllowed(hostname, currentAllowlist())) {
    throw new RouteRejectedError(
      `hostname "${hostname}" は allowlist (EXCUBITOR_CF_TUNNEL_ALLOWED_HOSTNAMES か設定 UI の CF Tunnel) に無いため変更できない`,
    );
  }
  return hostname;
}

/** @implements SPEC-CF-TUNNEL-ROUTES */
export function buildCfRemovalRouter(): Hono {
  const app = new Hono();

  app.post('/api/v1/cf-tunnel/dns/remove', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { hostname?: string; tunnel?: string } | null;
    if (!body?.hostname) return c.json({ error: 'bad_request', message: 'hostname は必須' }, 400);
    try {
      const hostname = allowedHostname(body.hostname);
      const creds = await resolveCfCredentials();
      const tunnel = await resolveTunnel(new CloudflareTunnelApi(creds), body.tunnel);
      const dns = new CloudflareDnsApi(creds);
      let zone = null;
      for (const candidate of zoneCandidates(hostname)) {
        zone = await dns.findZone(candidate);
        if (zone) break;
      }
      if (!zone) throw new RouteRejectedError(`"${hostname}" を含む zone がアカウントに無い`);
      const plan = planTunnelCnameRemoval(await dns.listRecords(zone.id, hostname), `${tunnel.id}.cfargotunnel.com`);
      if (plan.kind === 'delete') await dns.deleteRecord(zone.id, plan.recordId);
      logger.info({ hostname, zone: zone.name, removed: plan.kind === 'delete' }, 'cf-tunnel dns removed');
      return c.json({ ok: true, hostname, zone: zone.name, removed: plan.kind === 'delete' });
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'cf-tunnel dns remove failed');
      return c.json({ error: 'cf_tunnel_dns_remove_failed', message: (err as Error).message }, failureStatus(err));
    }
  });

  app.post('/api/v1/cf-tunnel/tunnels/remove', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { tunnel?: string; confirm?: string } | null;
    // 「唯一の tunnel」の暗黙指定は削除では使わない。
    if (!body?.tunnel) return c.json({ error: 'bad_request', message: 'tunnel (id か name) と confirm は必須' }, 400);
    try {
      const api = new CloudflareTunnelApi(await resolveCfCredentials());
      const tunnel = await resolveTunnel(api, body.tunnel);
      const config = await api.getConfiguration(tunnel.id);
      assertTunnelDeletable(tunnel, config.ingress ?? [], body.confirm);
      await api.deleteTunnel(tunnel.id);
      logger.info({ tunnel: tunnel.name }, 'cf-tunnel tunnel removed');
      return c.json({ ok: true, removed: true, tunnel: { id: tunnel.id, name: tunnel.name } });
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'cf-tunnel tunnel remove failed');
      return c.json({ error: 'cf_tunnel_remove_tunnel_failed', message: (err as Error).message }, failureStatus(err));
    }
  });

  return app;
}
