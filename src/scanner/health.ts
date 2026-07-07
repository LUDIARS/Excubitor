import { Socket } from 'node:net';
import { execCapture } from '../shared/exec.js';
import { managedPortsForService } from '../catalog/ports.js';
import type { Catalog, Service } from '../catalog/loader.js';
import { listListeners, type PortListener } from './ports.js';
import { listHostProcessImages, matchProcesses } from './host-process.js';

export interface ServiceHealthResult {
  ok: boolean;
  reason: 'http' | 'tcp' | 'cmd' | 'process' | 'port' | 'not_configured' | 'failed';
  detail?: string;
}

export interface HealthSnapshot {
  listeners: PortListener[];
  hostImages: Set<string> | null;
}

export async function readHealthSnapshot(): Promise<HealthSnapshot> {
  const [listeners, hostImages] = await Promise.all([
    listListeners(),
    listHostProcessImages(),
  ]);
  return { listeners, hostImages };
}

export async function probeServiceHealth(
  svc: Service,
  snapshot?: HealthSnapshot,
  timeoutMs = 1000,
): Promise<ServiceHealthResult> {
  const health = svc.health;
  if (health?.type === 'http') {
    if (!health.url) return { ok: false, reason: 'failed', detail: 'http health url missing' };
    try {
      const res = await fetch(health.url, { signal: AbortSignal.timeout(timeoutMs) });
      return {
        ok: res.ok,
        reason: res.ok ? 'http' : 'failed',
        detail: `HTTP ${res.status}`,
      };
    } catch (err) {
      return { ok: false, reason: 'failed', detail: (err as Error).message };
    }
  }

  if (health?.type === 'tcp') {
    const port = primaryHealthPort(svc);
    if (port == null) return { ok: false, reason: 'failed', detail: 'tcp health port missing' };
    const ok = await probeTcp(port, timeoutMs);
    return { ok, reason: ok ? 'tcp' : 'failed', detail: `localhost:${port}` };
  }

  if (health?.type === 'cmd') {
    if (!svc.command || !svc.cwd) return { ok: false, reason: 'failed', detail: 'cmd health command missing' };
    const r = await execCapture(svc.command, [], svc.cwd, timeoutMs);
    return { ok: r.ok, reason: r.ok ? 'cmd' : 'failed', detail: r.ok ? 'exit 0' : r.stderr.slice(-200) };
  }

  if (health?.type === 'process') {
    if (!svc.process_match) return { ok: false, reason: 'not_configured', detail: 'process_match missing' };
    const images = snapshot?.hostImages ?? await listHostProcessImages();
    if (images == null) return { ok: false, reason: 'failed', detail: 'host process listing unavailable' };
    const alive = matchProcesses([svc], images).has(svc.code);
    return { ok: alive, reason: alive ? 'process' : 'failed', detail: svc.process_match };
  }

  const listeners = snapshot?.listeners ?? await listListeners();
  const ports = managedPortsForService(svc);
  const alivePort = ports.find((p) => listeners.some((l) => l.port === p.port));
  if (alivePort) {
    return { ok: true, reason: 'port', detail: `${alivePort.role}:${alivePort.port}` };
  }
  if (ports.length > 0) {
    return { ok: false, reason: 'failed', detail: `no configured port listening (${ports.map((p) => p.port).join(',')})` };
  }
  return { ok: false, reason: 'not_configured' };
}

export async function serviceHealthResults(catalog: Catalog): Promise<Map<string, ServiceHealthResult>> {
  const snapshot = await readHealthSnapshot();
  const entries = await Promise.all(catalog.services.map(async (svc) => {
    const result = await probeServiceHealth(svc, snapshot);
    return [svc.code, result] as const;
  }));
  return new Map(entries);
}

export async function healthyServiceCodes(catalog: Catalog): Promise<Map<string, ServiceHealthResult>> {
  const results = await serviceHealthResults(catalog);
  return new Map([...results].filter(([, result]) => result.ok));
}

function primaryHealthPort(svc: Service): number | null {
  return svc.port ?? managedPortsForService(svc)[0]?.port ?? null;
}

function probeTcp(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, '127.0.0.1');
  });
}
