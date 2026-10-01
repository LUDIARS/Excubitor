/**
 * CF ブローカーの Access アプリ / DNS API。トークンは cf-tunnel と同じく Excubitor 内だけ。
 *   GET  /api/v1/cf-access/policies   … 再利用ポリシー一覧 {id, name, decision}
 *   POST /api/v1/cf-access/apps       … {hostname, name, policy_id, service}
 *        同じ domain のアプリがあれば再利用、無ければ self-hosted で作る。続けて team / AUD を
 *        サービスの runtime-config (cloudflareAccess) に書く。AUD は応答・ログに出さない。
 *   POST /api/v1/cf-tunnel/dns        … {hostname, tunnel?}
 *        tunnel に route がある hostname だけ、<tunnel>.cfargotunnel.com への proxied CNAME を作る。
 * 変更はすべて allowlist の hostname のみ。
 *
 * @implements SPEC-CF-TUNNEL-ROUTES (spec/feature/cf-tunnel-routes.md)
 */

import { Hono } from 'hono';
import { createNamedLogger } from '../shared/logger.js';
import { getServiceRuntimeConfig, saveServiceRuntimeConfig } from '../secrets/config-store.js';
import {
  accessIdentity,
  assertAppName,
  findAppForHostname,
  planTunnelCname,
  requireAllowPolicy,
  withCloudflareAccess,
  zoneCandidates,
} from './access-service.js';
import { currentAllowlist, failureStatus, resolveTunnel } from './broker-support.js';
import { CloudflareAccessApi } from './cloudflare-access-api.js';
import { CloudflareTunnelApi } from './cloudflare-api.js';
import { CloudflareDnsApi } from './cloudflare-dns-api.js';
import { resolveCfCredentials } from './credentials.js';
import { isHostnameAllowed, RouteRejectedError } from './route-service.js';

const logger = createNamedLogger('excubitor.cf-tunnel.access-router');

function assertAllowed(hostname: string): void {
  if (!isHostnameAllowed(hostname, currentAllowlist())) {
    throw new RouteRejectedError(
      `hostname "${hostname}" は allowlist (EXCUBITOR_CF_TUNNEL_ALLOWED_HOSTNAMES か設定 UI の CF Tunnel) に無いため変更できない`,
    );
  }
}

/** @implements SPEC-CF-TUNNEL-ROUTES */
export function buildCfAccessRouter(): Hono {
  const app = new Hono();

  app.get('/api/v1/cf-access/policies', async (c) => {
    try {
      const access = new CloudflareAccessApi(await resolveCfCredentials());
      return c.json({ policies: await access.listReusablePolicies() });
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'cf-access policies list failed');
      return c.json({ error: 'cf_access_policies_failed', message: (err as Error).message }, 502);
    }
  });

  app.post('/api/v1/cf-access/apps', async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      hostname?: string;
      name?: string;
      policy_id?: string;
      service?: string;
    } | null;
    if (!body?.hostname || !body?.name || !body?.policy_id || !body?.service) {
      return c.json({ error: 'bad_request', message: 'hostname / name / policy_id / service は必須' }, 400);
    }
    const hostname = body.hostname.trim().toLowerCase();
    try {
      assertAllowed(hostname);
      const name = assertAppName(body.name);
      const access = new CloudflareAccessApi(await resolveCfCredentials());
      let target = findAppForHostname(await access.listApps(), hostname);
      const created = target === null;
      if (!target) {
        const policy = requireAllowPolicy(await access.listReusablePolicies(), body.policy_id);
        target = await access.createSelfHostedApp({ name, domain: hostname, policyId: policy.id });
      }
      const identity = accessIdentity(await access.authDomain(), target);
      const runtime = saveServiceRuntimeConfig(
        body.service,
        withCloudflareAccess(getServiceRuntimeConfig(body.service), identity),
      );
      logger.info({ hostname, service: body.service, created }, 'cf-access app ready and runtime-config written');
      return c.json({
        ok: true,
        app: { id: target.id, name: target.name, domain: target.domain, created },
        team_domain: identity.teamDomain,
        service: body.service,
        runtime_config: runtime,
      });
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'cf-access app ensure failed');
      return c.json({ error: 'cf_access_app_failed', message: (err as Error).message }, failureStatus(err));
    }
  });

  app.post('/api/v1/cf-tunnel/dns', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { hostname?: string; tunnel?: string } | null;
    if (!body?.hostname) return c.json({ error: 'bad_request', message: 'hostname は必須' }, 400);
    const hostname = body.hostname.trim().toLowerCase();
    try {
      assertAllowed(hostname);
      const creds = await resolveCfCredentials();
      const tunnels = new CloudflareTunnelApi(creds);
      const tunnel = await resolveTunnel(tunnels, body.tunnel);
      const ingress = (await tunnels.getConfiguration(tunnel.id)).ingress ?? [];
      if (!ingress.some((r) => (r.hostname ?? '').toLowerCase() === hostname)) {
        throw new RouteRejectedError(`tunnel に "${hostname}" の route が無い。先に POST /api/v1/cf-tunnel/routes で足す`);
      }
      const dns = new CloudflareDnsApi(creds);
      let zone = null;
      for (const candidate of zoneCandidates(hostname)) {
        zone = await dns.findZone(candidate);
        if (zone) break;
      }
      if (!zone) throw new RouteRejectedError(`"${hostname}" を含む zone がアカウントに無い`);
      const target = `${tunnel.id}.cfargotunnel.com`;
      const plan = planTunnelCname(await dns.listRecords(zone.id, hostname), target);
      if (plan.kind === 'create') await dns.createProxiedCname(zone.id, hostname, target);
      logger.info({ hostname, zone: zone.name, created: plan.kind === 'create' }, 'cf-tunnel dns ensured');
      return c.json({ ok: true, hostname, zone: zone.name, created: plan.kind === 'create' });
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'cf-tunnel dns ensure failed');
      return c.json({ error: 'cf_tunnel_dns_failed', message: (err as Error).message }, failureStatus(err));
    }
  });

  return app;
}
