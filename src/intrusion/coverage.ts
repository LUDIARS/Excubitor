import type { IntrusionConfig } from './config.js';
import type { TunnelControl } from './containment.js';

/** Explicit read-only preflight; does not repoint production routes or claim other tunnels. */
export async function verifyCoverage(api: TunnelControl, config: IntrusionConfig, gatewayPort: number): Promise<{
  state: 'configured_tunnels_verified' | 'incomplete'; gaps: string[];
}> {
  const expected = `http://127.0.0.1:${gatewayPort}`;
  const gaps: string[] = [];
  for (const tunnel of config.tunnels) {
    const current = await api.getConfiguration(tunnel.id);
    const ingress = current.ingress ?? [];
    for (const host of tunnel.hostnames) {
      const rules = ingress.filter(rule => rule.hostname?.toLowerCase() === host);
      if (!rules.some(rule => !rule.path) || rules.some(rule => rule.service.replace(/\/$/, '') !== expected)) {
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
