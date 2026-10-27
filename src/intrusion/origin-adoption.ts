import { createHash } from 'node:crypto';
import type { CfIngressRule, CfTunnelConfig } from '../cf-tunnel/cloudflare-api.js';
import type { IntrusionConfig } from './config.js';
import type { TunnelControl } from './containment.js';
import type { OriginApprovals } from './origin-approvals.js';
import { matchesPublicRule, originOptions, planGatewayRoutes } from './route-plan.js';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, entry]) => [key, canonical(entry)]));
  return value;
}
function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export function publicRuleHash(rule: CfIngressRule, config: CfTunnelConfig): string {
  return digest({ rule, originRequest: config.originRequest ?? null });
}

/** Prove existing exposure before opening an exceptional origin; never change CF here. */
export async function verifyExistingOrigins(api: TunnelControl, config: IntrusionConfig, port: number,
  approvals: OriginApprovals, managementKeys: ReadonlySet<string>, recordNew = true): Promise<void> {
  const snapshots = new Map<string, CfTunnelConfig>();
  for (const route of config.routes) {
    if (!route.adoptExisting) continue;
    const { tunnelId, sourceHash } = route.adoptExisting;
    let snapshot = snapshots.get(tunnelId);
    if (!snapshot) { snapshot = await api.getConfiguration(tunnelId); snapshots.set(tunnelId, snapshot); }
    const matches = (snapshot.ingress ?? []).filter(rule => matchesPublicRule(rule, route));
    if (matches.length !== 1 || !route.routeKey) throw new Error('existing origin rule is missing or ambiguous');
    const rule = matches[0]!;
    const hash = publicRuleHash(rule, snapshot);
    const key = `${tunnelId}/${route.routeKey}`;
    const fingerprint = digest({ route, management: managementKeys.has(route.routeKey), gatewayPort: port });
    const approved = approvals.get(key);
    if (approved) {
      if (approved.fingerprint !== fingerprint || !approved.hashes.includes(hash)) throw new Error('approved origin or tunnel policy changed');
      continue;
    }
    if (!recordNew) throw new Error('recorded origin approval is missing');
    if (hash !== sourceHash) throw new Error('existing origin source proof mismatch');
    const effective = { ...originOptions({ service: '', originRequest: snapshot.originRequest }), ...originOptions(rule) };
    if (effective.http2Origin === true || (route.origin.startsWith('https:') &&
        effective.originServerName && effective.originServerName !== new URL(route.origin).hostname)) {
      throw new Error('origin transport options require a separate migration');
    }
    if (managementKeys.has(route.routeKey)) {
      const access = effective.access as { required?: boolean; audTag?: unknown[]; teamName?: string } | undefined;
      if (access?.required !== true || !Array.isArray(access.audTag) || !access.audTag.length || !access.teamName) {
        throw new Error('existing management route requires Cloudflare Access validation');
      }
    }
    // A single-route plan validates the actual original origin and forwarded Host.
    const subset = { ...config, routes: [route], tunnels: [{ id: tunnelId, hostnames: [route.hostname] }] };
    const migrated = planGatewayRoutes(snapshot, subset, tunnelId, port).ingress?.find(entry => matchesPublicRule(entry, route));
    if (!migrated) throw new Error('migration rule missing');
    approvals.save(key, { fingerprint, hashes: [hash, publicRuleHash(migrated, snapshot),
      publicRuleHash({ ...rule, service: 'http_status:503' }, snapshot),
      publicRuleHash({ ...migrated, service: 'http_status:503' }, snapshot)] });
  }
}
