/** Process-local mutation boundary for Ex's public-route broker. */
let guarded: { hosts: Set<string>; gateway: string; blocked: () => boolean } | null = null;

export function installIntrusionRouteGuard(hosts: string[], gateway: string, blocked: () => boolean): () => void {
  if (guarded) throw new Error('intrusion route guard already installed');
  guarded = { hosts: new Set(hosts), gateway, blocked };
  return () => { guarded = null; };
}

export function assertIntrusionRouteMutation(hostname: string, service: string): void {
  if (!guarded?.hosts.has(hostname.trim().toLowerCase())) return;
  if (guarded.blocked()) throw new Error('intrusion latch blocks public route changes; use the maintenance recovery procedure');
  if (service.replace(/\/$/, '') !== guarded.gateway) throw new Error('protected hostname must route through the intrusion gateway');
}
