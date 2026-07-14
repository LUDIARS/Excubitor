import type { Service } from './loader.js';

export interface ManagedPort {
  role: string;
  port: number;
  env: string | null;
}

export function managedPortsForService(svc: Service): ManagedPort[] {
  const out: ManagedPort[] = [];
  const seen = new Set<number>();
  const add = (role: string, port: number | undefined, env?: string | null): void => {
    if (typeof port !== 'number' || seen.has(port)) return;
    seen.add(port);
    out.push({ role, port, env: env ?? null });
  };

  add(svc.component ?? 'service', svc.port ?? undefined);
  add('frontend', svc.frontend_port ?? undefined);
  add('backend', svc.backend_port ?? undefined);
  for (const p of svc.ports ?? []) add(p.role, p.port, p.env ?? null);
  return out;
}
