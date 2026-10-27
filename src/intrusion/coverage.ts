import type { IntrusionConfig } from './config.js';
import type { TunnelControl } from './containment.js';
import { matchesPublicRule, originOptions } from './route-plan.js';

/** Explicit read-only preflight; does not repoint production routes or claim other tunnels. */
export async function verifyCoverage(api: TunnelControl, config: IntrusionConfig, gatewayPort: number): Promise<{
  state: 'configured_tunnels_verified' | 'incomplete'; gaps: string[];
}> {
  const expected = `http://127.0.0.1:${gatewayPort}`;
  const gaps: string[] = [];
  for (const tunnel of config.tunnels) {
    const current = await api.getConfiguration(tunnel.id);
    const ingress = current.ingress ?? [];
    const inherited = originOptions({ service: '', originRequest: current.originRequest });
    for (const host of tunnel.hostnames) {
      const rules = ingress.filter(rule => rule.hostname?.toLowerCase() === host);
      const routes = config.routes.filter(route => route.hostname === host);
      const invalid = rules.some(rule => {
        const route = routes.find(entry => matchesPublicRule(rule, entry));
        if (!route || rule.service.replace(/\/$/, '') !== expected) return true;
        const header = originOptions(rule).httpHostHeader ?? inherited.httpHostHeader ?? host;
        return header !== (route.routeKey ?? route.hostname);
      });
      if (invalid || routes.some(route => rules.filter(rule => matchesPublicRule(rule, route)).length !== 1)) {
        gaps.push(`gateway_not_exclusive:${host}`);
      }
    }
    if (ingress.some(rule => rule.hostname && !tunnel.hostnames.includes(rule.hostname.toLowerCase()) && !rule.service.startsWith('http_status:'))) {
      gaps.push(`uncovered_routes:${tunnel.id}`);
    }
    const fallback = ingress.at(-1);
    if (!fallback || fallback.hostname || !/^http_status:(404|503)$/.test(fallback.service)) gaps.push(`unsafe_fallback:${tunnel.id}`);
  }
  return { state: gaps.length ? 'incomplete' : 'configured_tunnels_verified', gaps };
}
