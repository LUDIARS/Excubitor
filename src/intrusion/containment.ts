import type { CfTunnelConfig, CfIngressRule } from '../cf-tunnel/cloudflare-api.js';
import type { IntrusionConfig } from './config.js';

export interface TunnelControl {
  getConfiguration(id: string): Promise<CfTunnelConfig>;
  putConfiguration(id: string, config: CfTunnelConfig): Promise<CfTunnelConfig>;
}

export function blockedIngress(ingress: CfIngressRule[], hosts: string[]): CfIngressRule[] {
  if (!ingress.length || ingress.at(-1)?.hostname) throw new Error('missing terminal catch-all');
  for (const host of hosts) {
    if (!ingress.some(rule => rule.hostname?.toLowerCase() === host)) throw new Error('configured hostname missing');
  }
  return ingress.map(rule => rule.hostname && hosts.includes(rule.hostname.toLowerCase())
    ? { ...rule, service: 'http_status:503' } : rule);
}

/** Read before retry, preserve non-target rules, verify remote state after every write. */
export async function containTunnels(api: TunnelControl, config: IntrusionConfig, allowed: string[],
  saveSnapshot: (id: string, before: CfTunnelConfig) => void): Promise<void> {
  let failed = false;
  for (const tunnel of config.tunnels) {
    try {
      if (tunnel.hostnames.some(h => !allowed.includes(h))) throw new Error('hostname not authorized');
      const before = await api.getConfiguration(tunnel.id);
      const ingress = blockedIngress(before.ingress ?? [], tunnel.hostnames);
      if (JSON.stringify(ingress) !== JSON.stringify(before.ingress)) {
        saveSnapshot(tunnel.id, before);
        await api.putConfiguration(tunnel.id, { ...before, ingress });
      }
      const after = await api.getConfiguration(tunnel.id);
      const expected = blockedIngress(after.ingress ?? [], tunnel.hostnames);
      if (JSON.stringify(expected) !== JSON.stringify(after.ingress)) throw new Error('containment readback mismatch');
    } catch { failed = true; /* Continue containing other configured tunnels; report aggregate failure. */ }
  }
  if (failed) throw new Error('one or more configured tunnels could not be confirmed blocked');
}
