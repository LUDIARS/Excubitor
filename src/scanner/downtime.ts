import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

export interface LivenessSample {
  t: number;
  ok: number | boolean;
}

export interface DowntimeSummary {
  window_ms: number;
  downtime_ms: number;
  uptime_ratio: number | null;
  incidents: number;
  current_down_since: number | null;
  current_down_ms: number;
  last_probe_at: number | null;
  last_ok_at: number | null;
  last_down_at: number | null;
}

const DEFAULT_WINDOW_MIN = 24 * 60;
const SUMMARY_CACHE_TTL_MS = 5_000;
const summaryCache = new Map<string, { capturedAt: number; value: Map<string, DowntimeSummary> }>();

export function computeDowntimeSummary(
  samples: LivenessSample[],
  opts: { since: number; now: number; windowMs: number },
): DowntimeSummary {
  const since = Math.min(opts.since, opts.now);
  const now = opts.now;
  const sorted = [...samples]
    .map((s) => ({ t: Math.floor(s.t), ok: Boolean(s.ok) }))
    .filter((s) => Number.isFinite(s.t) && s.t <= now)
    .sort((a, b) => a.t - b.t);

  let downtimeMs = 0;
  let incidents = 0;
  let state: boolean | null = null;
  let cursor = since;
  let lastProbeAt: number | null = null;
  let lastOkAt: number | null = null;
  let lastDownAt: number | null = null;
  let currentDownSince: number | null = null;

  for (const sample of sorted) {
    if (sample.t < since) {
      state = sample.ok;
      lastProbeAt = sample.t;
      if (sample.ok) lastOkAt = sample.t;
      else {
        lastDownAt = sample.t;
        currentDownSince = sample.t;
      }
      continue;
    }

    if (state === false) downtimeMs += Math.max(0, sample.t - cursor);
    if (sample.ok === false && state !== false) {
      incidents += 1;
      currentDownSince = sample.t;
    }
    if (sample.ok) {
      lastOkAt = sample.t;
      currentDownSince = null;
    } else {
      lastDownAt = sample.t;
    }
    state = sample.ok;
    cursor = sample.t;
    lastProbeAt = sample.t;
  }

  if (state === false) downtimeMs += Math.max(0, now - cursor);
  const windowMs = Math.max(0, opts.windowMs);
  const boundedDowntimeMs = Math.max(0, Math.min(downtimeMs, windowMs));

  return {
    window_ms: windowMs,
    downtime_ms: boundedDowntimeMs,
    uptime_ratio: windowMs > 0 ? Math.max(0, Math.min(1, 1 - boundedDowntimeMs / windowMs)) : null,
    incidents,
    current_down_since: state === false ? currentDownSince ?? lastDownAt : null,
    current_down_ms: state === false && (currentDownSince ?? lastDownAt) != null
      ? Math.max(0, now - (currentDownSince ?? lastDownAt)!)
      : 0,
    last_probe_at: lastProbeAt,
    last_ok_at: lastOkAt,
    last_down_at: lastDownAt,
  };
}

export function downtimeSummaryForService(code: string, windowMin = 24 * 60, now = Date.now()): DowntimeSummary | null {
  return downtimeSummariesForServices([code], windowMin, now).get(code) ?? null;
}

export function downtimeSummariesForServices(
  codes: string[],
  windowMin = DEFAULT_WINDOW_MIN,
  now = Date.now(),
): Map<string, DowntimeSummary> {
  const uniqueCodes = [...new Set(codes.map((c) => c.trim()).filter(Boolean))].sort();
  if (uniqueCodes.length === 0) return new Map();
  const windowMs = Math.max(60_000, Math.floor(windowMin * 60_000));
  const since = now - windowMs;
  const cacheKey = `${windowMs}:${Math.floor(now / SUMMARY_CACHE_TTL_MS)}:${uniqueCodes.join('\0')}`;
  const cached = summaryCache.get(cacheKey);
  if (cached && now - cached.capturedAt < SUMMARY_CACHE_TTL_MS) return new Map(cached.value);
  const result = queryDowntimeSummaries(uniqueCodes, since, now, windowMs);
  summaryCache.set(cacheKey, { capturedAt: now, value: new Map(result) });
  if (summaryCache.size > 16) {
    const oldest = [...summaryCache.entries()].sort((a, b) => a[1].capturedAt - b[1].capturedAt)[0]?.[0];
    if (oldest) summaryCache.delete(oldest);
  }
  return result;
}

function queryDowntimeSummaries(
  codes: string[],
  since: number,
  now: number,
  windowMs: number,
): Map<string, DowntimeSummary> {
  const codeList = sql.join(codes.map((code) => sql`${code}`), sql`, `);
  const rows = db().all(sql`
    SELECT code, t, ok
    FROM (
      SELECT s.code AS code, lh.probed_at AS t, lh.ok AS ok, lh.id AS id
      FROM services s
      JOIN service_instances si ON si.service_id = s.id
      JOIN liveness_history lh ON lh.service_instance_id = si.id
      WHERE s.is_active = 1
        AND s.code IN (${codeList})
        AND lh.probed_at >= ${since}

      UNION ALL

      SELECT s.code AS code, lh.probed_at AS t, lh.ok AS ok, lh.id AS id
      FROM services s
      JOIN liveness_history lh ON lh.id = (
        SELECT lh2.id
        FROM liveness_history lh2
        JOIN service_instances si2 ON si2.id = lh2.service_instance_id
        WHERE si2.service_id = s.id
          AND lh2.probed_at < ${since}
        ORDER BY lh2.probed_at DESC, lh2.id DESC
        LIMIT 1
      )
      WHERE s.is_active = 1
        AND s.code IN (${codeList})
    )
    ORDER BY code ASC, t ASC, id ASC
  `) as Array<{ code: string; t: number; ok: number }>;

  const samplesByCode = new Map<string, LivenessSample[]>();
  for (const row of rows) {
    const list = samplesByCode.get(row.code) ?? [];
    list.push({ t: Number(row.t), ok: Number(row.ok) });
    samplesByCode.set(row.code, list);
  }

  const result = new Map<string, DowntimeSummary>();
  for (const [code, samples] of samplesByCode.entries()) {
    result.set(code, computeDowntimeSummary(samples, { since, now, windowMs }));
  }
  return result;
}
