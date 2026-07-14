/**
 * メモリ監視の読み出し API (`/api/v1/memory/*`)。
 *
 * - GET /api/v1/memory/summary : 全ターゲットの最新値 + leak 判定 + sparkline 用の短い系列。
 * - GET /api/v1/memory/series  : 1 ターゲットの詳細時系列 (kind/key/window_min/source 指定)。
 *
 * leak 判定は書き込み側 (collector) と同じ detectLeak を read 時に再計算する (verdict の単一実装)。
 */

import { Hono } from 'hono';
import type { Catalog, Service } from '../catalog/loader.js';
import { detectLeak, type LeakResult } from './leak.js';
import { latestPerTarget, querySeries, toLeakSamples, type LatestTarget } from './store.js';

const SPARK_POINTS = 80;

interface TargetCard {
  target_kind: string;
  target_key: string;
  name: string;
  /** rss を持つ主 source (process/docker/wsl/host)。 */
  primary_source: string;
  rss_bytes: number | null;
  heap_used_bytes: number | null;
  heap_total_bytes: number | null;
  external_bytes: number | null;
  array_buffers_bytes: number | null;
  /** CPU 使用率 (%)、 取得不能なら null。 */
  cpu_pct: number | null;
  pid: number | null;
  detail: Record<string, unknown> | null;
  sampled_at: number;
  leak: LeakResult;
  spark: Array<{ t: number; rss: number }>;
  /** CPU の sparkline (host / service)。 */
  cpu_spark: Array<{ t: number; cpu: number }>;
  budget: {
    rss_budget_bytes: number | null;
    cpu_budget_pct: number | null;
    rss_ok: boolean | null;
    cpu_ok: boolean | null;
    ok: boolean | null;
  };
}

function primarySourceForKind(kind: string, runtime?: string): 'process' | 'docker' | 'wsl' | 'host' {
  if (kind === 'host') return 'host';
  if (kind === 'wsl') return 'wsl';
  if (runtime === 'docker-compose' || runtime === 'docker') return 'docker';
  return 'process';
}

function leakWindowFor(svc: Service | undefined, catalog: Catalog, kind: string): { windowMs: number; thresholdBytes: number } {
  if (kind === 'wsl') {
    const w = catalog.memory_monitor.wsl;
    return { windowMs: w.leak_window_min * 60_000, thresholdBytes: w.leak_threshold_mb_per_hr * 1024 * 1024 };
  }
  const windowMin = svc?.memory?.leak_window_min ?? 60;
  const thresholdMbPerHr = svc?.memory?.leak_threshold_mb_per_hr ?? 50;
  return { windowMs: windowMin * 60_000, thresholdBytes: thresholdMbPerHr * 1024 * 1024 };
}

export function buildMemoryRouter(getCatalog: () => Catalog): Hono {
  const app = new Hono();

  app.get('/api/v1/memory/summary', (c) => {
    const catalog = getCatalog();
    const svcByCode = new Map(catalog.services.map((s) => [s.code, s] as const));
    const latest = latestPerTarget();

    // (kind,key) でグルーピングして source 横断にマージ。
    const grouped = new Map<string, LatestTarget[]>();
    for (const row of latest) {
      const k = `${row.target_kind}${row.target_key}`;
      const arr = grouped.get(k) ?? [];
      arr.push(row);
      grouped.set(k, arr);
    }

    const now = Date.now();
    const cards: TargetCard[] = [];
    for (const rows of grouped.values()) {
      const kind = rows[0]!.target_kind;
      const key = rows[0]!.target_key;
      const svc = svcByCode.get(key);
      const primary = primarySourceForKind(kind, svc?.runtime);

      // rss は primary source、 heap 内訳は metrics source から拾う。
      const rssRow = rows.find((r) => r.source === primary) ?? rows[0]!;
      const metricsRow = rows.find((r) => r.source === 'metrics');

      const { windowMs, thresholdBytes } = leakWindowFor(svc, catalog, kind);
      const sinceMs = kind === 'service' && rssRow.service_started_at
        ? Math.max(now - windowMs, Number(rssRow.service_started_at))
        : now - windowMs;
      const series = querySeries(
        kind,
        key,
        sinceMs,
        primary,
        kind === 'service' && rssRow.service_instance_id
          ? { serviceInstanceId: rssRow.service_instance_id }
          : undefined,
      );
      // host はマシン全体メモリのため leak 判定は無意味 → insufficient 扱い。
      const leak = kind === 'host'
        ? detectLeak([], { windowMs, thresholdBytesPerHour: thresholdBytes, minSamples: 8 })
        : detectLeak(toLeakSamples(series), {
            windowMs,
            thresholdBytesPerHour: thresholdBytes,
            minSamples: 8,
          });
      const spark = downsample(series.map((r) => ({ t: r.t, rss: r.rss })).filter((s): s is { t: number; rss: number } => s.rss != null), SPARK_POINTS);
      const cpuSpark = downsample(series.map((r) => ({ t: r.t, cpu: r.cpu })).filter((s): s is { t: number; cpu: number } => s.cpu != null), SPARK_POINTS);

      cards.push({
        target_kind: kind,
        target_key: key,
        name: kind === 'host' ? 'マシン全体' : (svc?.name ?? key),
        primary_source: primary,
        rss_bytes: rssRow.rss_bytes,
        heap_used_bytes: metricsRow?.heap_used_bytes ?? null,
        heap_total_bytes: metricsRow?.heap_total_bytes ?? null,
        external_bytes: metricsRow?.external_bytes ?? null,
        array_buffers_bytes: metricsRow?.array_buffers_bytes ?? null,
        cpu_pct: rssRow.cpu_pct,
        pid: rssRow.pid,
        detail: parseDetail(rssRow.detail),
        sampled_at: Number(rssRow.sampled_at),
        leak,
        spark,
        cpu_spark: cpuSpark,
        budget: budgetFor(catalog, svc, rssRow.rss_bytes, rssRow.cpu_pct),
      });
    }

    cards.sort((a, b) => {
      // leaking を先頭へ、 次に RSS 降順。
      const rank = (v: string): number => (v === 'leaking' ? 0 : v === 'suspect' ? 1 : 2);
      const d = rank(a.leak.verdict) - rank(b.leak.verdict);
      if (d !== 0) return d;
      return (b.rss_bytes ?? 0) - (a.rss_bytes ?? 0);
    });

    return c.json({
      services: cards.filter((c) => c.target_kind === 'service'),
      wsl: cards.filter((c) => c.target_kind === 'wsl'),
      host: cards.find((c) => c.target_kind === 'host') ?? null,
    });
  });

  app.get('/api/v1/memory/series', (c) => {
    const kind = c.req.query('kind') ?? 'service';
    const key = c.req.query('key');
    if (!key) return c.json({ error: 'key_required' }, 400);
    const windowMin = Math.max(1, Math.min(1440, Number(c.req.query('window_min') ?? 120)));
    const source = c.req.query('source') || undefined;
    const instanceId = c.req.query('instance_id') || undefined;
    const rows = querySeries(
      kind,
      key,
      Date.now() - windowMin * 60_000,
      source,
      instanceId ? { serviceInstanceId: instanceId } : undefined,
    );
    return c.json({ kind, key, window_min: windowMin, source: source ?? null, series: rows });
  });

  return app;
}

function budgetFor(
  catalog: Catalog,
  svc: Service | undefined,
  rssBytes: number | null,
  cpuPct: number | null,
): TargetCard['budget'] {
  const rssMb = svc?.memory?.rss_budget_mb ?? (svc ? catalog.memory_monitor.default_service_rss_budget_mb : null);
  const cpuBudgetPct = svc?.memory?.cpu_budget_pct ?? (svc ? catalog.memory_monitor.default_service_cpu_budget_pct : null);
  const rssBudgetBytes = rssMb != null ? rssMb * 1024 * 1024 : null;
  const rssOk = rssBudgetBytes != null && rssBytes != null ? rssBytes <= rssBudgetBytes : null;
  const cpuOk = cpuBudgetPct != null && cpuPct != null ? cpuPct <= cpuBudgetPct : null;
  const checks = [rssOk, cpuOk].filter((v): v is boolean => v !== null);
  return {
    rss_budget_bytes: rssBudgetBytes,
    cpu_budget_pct: cpuBudgetPct,
    rss_ok: rssOk,
    cpu_ok: cpuOk,
    ok: checks.length > 0 ? checks.every(Boolean) : null,
  };
}

/** 系列を最大 max 点に等間隔ダウンサンプル (sparkline 用)。 */
function downsample<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr;
  const step = arr.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(arr[Math.floor(i * step)]!);
  out.push(arr[arr.length - 1]!);
  return out;
}

function parseDetail(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}
