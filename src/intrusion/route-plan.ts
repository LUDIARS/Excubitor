import type { CfIngressRule, CfTunnelConfig } from '../cf-tunnel/cloudflare-api.js';
import type { IntrusionConfig } from './config.js';

type Route = IntrusionConfig['routes'][number];

export function matchesPublicRule(rule: CfIngressRule, route: Route): boolean {
  return rule.hostname?.toLowerCase() === route.hostname && (rule.path ?? '') === (route.path ?? '');
}

export function originOptions(rule: CfIngressRule): Record<string, unknown> {
  const value = rule.originRequest;
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid originRequest');
  return value as Record<string, unknown>;
}

/** Pure migration plan. No writes; reject stale/mismatched inventory before changing any rule. */
export function planGatewayRoutes(before: CfTunnelConfig, config: IntrusionConfig,
  tunnelId: string, port: number): CfTunnelConfig {
  const tunnel = config.tunnels.find(entry => entry.id === tunnelId);
  if (!tunnel || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid gateway target');
  const routes = config.routes.filter(route => tunnel.hostnames.includes(route.hostname));
  const ingress = before.ingress ?? [];
  const globalOptions = originOptions({ service: '', originRequest: before.originRequest });
  for (const route of routes) {
    if (ingress.filter(rule => matchesPublicRule(rule, route)).length !== 1) throw new Error('ambiguous or missing public rule');
  }
  return { ...before, ingress: ingress.map(rule => {
    const route = routes.find(entry => matchesPublicRule(rule, entry));
    if (!route) return rule;
    const original = new URL(rule.service);
    if (original.hostname === 'localhost') original.hostname = '127.0.0.1';
    const options = originOptions(rule);
    if (original.href !== new URL(route.origin).href ||
        (options.httpHostHeader ?? globalOptions.httpHostHeader ?? route.hostname) !== (route.forwardHost ?? route.hostname)) {
      throw new Error('origin inventory changed');
    }
    return { ...rule, service: `http://127.0.0.1:${port}`,
      originRequest: { ...options, httpHostHeader: route.routeKey ?? route.hostname } };
  }) };
}
