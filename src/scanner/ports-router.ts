/**
 * ポート衝突検知 API (`/api/v1/ports`)。
 * catalog 宣言 port の占有状況 + 重複宣言 + 現在の LISTEN 一覧を返す (req5)。
 */

import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { Catalog } from '../catalog/loader.js';
import { managedPortsForService } from '../catalog/ports.js';
import { buildPortReport, detectDeclaredConflicts, type PortReport, type ServicePortStatus } from './ports.js';
import { createNamedLogger } from '../shared/logger.js';
import { writeDiagnostic } from '../shared/diagnostic-log.js';
import { acquireRedisLock, readRedisJson, redisCacheKey, writeRedisJson } from '../shared/redis-cache.js';

const PORT_REPORT_CACHE_MS = readPositiveIntEnv('EXCUBITOR_PORT_REPORT_CACHE_MS', 5_000);
const PORT_REPORT_REDIS_REPOPULATE_MS = Math.min(PORT_REPORT_CACHE_MS, 2_000);
const PORT_REPORT_REDIS_TTL_MS = cacheStorageTtl(PORT_REPORT_CACHE_MS);
const PORT_REPORT_CACHE_KEY = redisCacheKey('ports:v1');
const PORT_REPORT_LOCK_KEY = `${PORT_REPORT_CACHE_KEY}:refresh`;
const logger = createNamedLogger('excubitor.ports.router');

interface PortReportCache {
  report: PortReport;
  capturedAt: number;
}

function stateByCode(): Map<string, string> {
  const rows = db().all(sql`
    SELECT s.code AS code, si.state AS state
    FROM services s
    LEFT JOIN service_instances si ON si.service_id = s.id
    WHERE s.is_active = 1
  `) as Array<{ code: string; state: string | null }>;
  const map = new Map<string, string>();
  for (const r of rows) map.set(r.code, r.state ?? 'unknown');
  return map;
}

export function buildPortsRouter(getCatalog: () => Catalog): Hono {
  const app = new Hono();
  let localFallback: PortReportCache | null = null;
  let pending: Promise<void> | null = null;
  let lastRedisPopulateAttempt = 0;

  function refresh(): void {
    if (pending) return;
    lastRedisPopulateAttempt = Date.now();
    pending = (async () => {
      const lock = await acquireRedisLock(PORT_REPORT_LOCK_KEY, Math.max(PORT_REPORT_CACHE_MS, 1_000));
      if (lock === false) return;
      const next = await buildPortReport(getCatalog(), stateByCode());
      const entry = { report: next, capturedAt: Date.now() };
      localFallback = entry;
      if (lock === true) await writeRedisJson(PORT_REPORT_CACHE_KEY, entry, PORT_REPORT_REDIS_TTL_MS);
    })()
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ err: message }, 'port report refresh failed');
        writeDiagnostic('ports.report.refresh.failed', { err: message });
      })
      .finally(() => {
        pending = null;
      });
  }

  async function report(): Promise<PortReport> {
    const now = Date.now();
    if (localFallback && now - localFallback.capturedAt < PORT_REPORT_CACHE_MS) {
      return localFallback.report;
    }
    const cached = await readRedisJson<PortReportCache>(PORT_REPORT_CACHE_KEY);
    if (cached) {
      const sourceStale = now - cached.capturedAt >= PORT_REPORT_CACHE_MS;
      localFallback = { report: cached.report, capturedAt: now };
      if (sourceStale) refresh();
      return cached.report;
    }
    if (!localFallback) {
      localFallback = { report: fallbackReport(getCatalog(), stateByCode()), capturedAt: 0 };
    }
    if (
      now - localFallback.capturedAt >= PORT_REPORT_CACHE_MS
      || now - lastRedisPopulateAttempt >= PORT_REPORT_REDIS_REPOPULATE_MS
    ) refresh();
    return localFallback.report;
  }

  app.get('/api/v1/ports', async (c) => {
    return c.json(await report());
  });

  refresh();
  return app;
}

function fallbackReport(catalog: Catalog, states: Map<string, string>): PortReport {
  const services: ServicePortStatus[] = catalog.services.flatMap((svc) => (
    managedPortsForService(svc).map((port) => ({
      code: svc.code,
      name: svc.name,
      role: port.role,
      port: port.port,
      state: states.get(svc.code) ?? 'unknown',
      listening: false,
      pids: [],
      processNames: [],
      conflict: false,
    }))
  ));
  return {
    listeners: [],
    declaredConflicts: detectDeclaredConflicts(catalog),
    services,
    hasConflict: false,
  };
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function cacheStorageTtl(freshMs: number): number {
  return Math.max(freshMs * 12, 60_000);
}
