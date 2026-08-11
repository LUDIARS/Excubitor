/**
 * ポートレポートのキャッシュ提供。
 *
 * SRP: 「今の LISTEN 状況を、 何度聞かれても実測は数秒に 1 回で返す」ところまで。
 * HTTP に出すのは ports-router.ts、 占有者の判定は process/port-ownership.ts が持つ。
 *
 * 切り出した理由: サービス状態 API (`/api/v1/services`) も同じリスナー一覧を要る
 * (宣言ポートを管理外プロセスが握っていないかの判定に使う)。 エンドポイントごとに
 * 実測すると、 WebUI のポーリングでプロセス列挙が多重に走る。
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { Catalog } from '../catalog/loader.js';
import { managedPortsForService } from '../catalog/ports.js';
import { buildPortReport, detectDeclaredConflicts, type PortReport, type ServicePortStatus } from './ports.js';
import { createNamedLogger } from '../shared/logger.js';
import { writeDiagnostic } from '../shared/diagnostic-log.js';
import { acquireRedisLock, readRedisJson, redisCacheKey, writeRedisJson } from '../shared/redis-cache.js';

const configuredCacheMs = Number(process.env.EXCUBITOR_PORT_REPORT_CACHE_MS);
const PORT_REPORT_CACHE_MS = Number.isFinite(configuredCacheMs) && configuredCacheMs > 0
  ? Math.floor(configuredCacheMs)
  : 5_000;
const PORT_REPORT_REDIS_REPOPULATE_MS = Math.min(PORT_REPORT_CACHE_MS, 2_000);
const PORT_REPORT_REDIS_TTL_MS = Math.max(PORT_REPORT_CACHE_MS * 12, 60_000);
const PORT_REPORT_CACHE_KEY = redisCacheKey('ports:v1');
const PORT_REPORT_LOCK_KEY = `${PORT_REPORT_CACHE_KEY}:refresh`;
const logger = createNamedLogger('excubitor.ports.cache');

interface PortReportCache {
  report: PortReport;
  capturedAt: number;
}

export interface PortReportSnapshot {
  report: PortReport;
  /** false の場合、report は起動直後の合成 fallback であり LISTEN の実測ではない。 */
  listenersObserved: boolean;
}

export interface PortReportProvider {
  /** キャッシュが新しければそれを、古ければ裏で更新しつつ直近値と実測有無を返す。 */
  snapshot(): Promise<PortReportSnapshot>;
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

export function createPortReportProvider(getCatalog: () => Catalog): PortReportProvider {
  let localFallback: (PortReportCache & { listenersObserved: boolean }) | null = null;
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
      localFallback = { ...entry, listenersObserved: true };
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

  refresh();
  return {
    async snapshot(): Promise<PortReportSnapshot> {
      const now = Date.now();
      if (localFallback && now - localFallback.capturedAt < PORT_REPORT_CACHE_MS) {
        return { report: localFallback.report, listenersObserved: localFallback.listenersObserved };
      }
      const cached = await readRedisJson<PortReportCache>(PORT_REPORT_CACHE_KEY);
      if (cached) {
        const sourceStale = now - cached.capturedAt >= PORT_REPORT_CACHE_MS;
        localFallback = { report: cached.report, capturedAt: now, listenersObserved: true };
        if (sourceStale) refresh();
        return { report: cached.report, listenersObserved: true };
      }
      if (!localFallback) {
        localFallback = {
          report: fallbackReport(getCatalog(), stateByCode()),
          capturedAt: 0,
          listenersObserved: false,
        };
      }
      if (
        now - localFallback.capturedAt >= PORT_REPORT_CACHE_MS
        || now - lastRedisPopulateAttempt >= PORT_REPORT_REDIS_REPOPULATE_MS
      ) refresh();
      return { report: localFallback.report, listenersObserved: localFallback.listenersObserved };
    },
  };
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

