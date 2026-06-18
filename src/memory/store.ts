/**
 * memory_samples の永続化・読み出し・剪定 + leak の error_task 起票。
 *
 * raw SQL は scanner/sync.ts と同じく drizzle の sql`` を使う (PG 由来構文は SQLite 用に展開済み)。
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { MemorySample } from './types.js';
import type { LeakSample } from './leak.js';

/** 1 tick 分のサンプルをまとめて insert。 */
export function insertSamples(samples: MemorySample[]): void {
  if (samples.length === 0) return;
  const now = Date.now();
  // drizzle(better-sqlite3) の transaction はコールバックを即時実行し結果を返す
  // (raw better-sqlite3 のように runnable 関数を返さない)。
  db().transaction(() => {
    for (const s of samples) {
      db().run(sql`
        INSERT INTO memory_samples (
          target_kind, target_key, service_instance_id, source, sampled_at,
          rss_bytes, heap_used_bytes, heap_total_bytes, external_bytes, array_buffers_bytes,
          pid, detail
        ) VALUES (
          ${s.targetKind}, ${s.targetKey}, ${s.serviceInstanceId}, ${s.source}, ${now},
          ${s.rssBytes}, ${s.heapUsedBytes ?? null}, ${s.heapTotalBytes ?? null},
          ${s.externalBytes ?? null}, ${s.arrayBuffersBytes ?? null},
          ${s.pid ?? null}, ${s.detail ? JSON.stringify(s.detail) : null}
        )
      `);
    }
  });
}

/** retention より古いサンプルを削除する。 */
export function pruneSamples(olderThanMs: number): number {
  const res = db().run(sql`DELETE FROM memory_samples WHERE sampled_at < ${olderThanMs}`);
  return res.changes ?? 0;
}

export interface SeriesRow {
  t: number;
  rss: number | null;
  heap_used: number | null;
  heap_total: number | null;
  external: number | null;
  array_buffers: number | null;
}

/**
 * 指定ターゲット (+任意で source) の RSS 時系列を since 以降で昇順取得する。
 * source 省略時は全 source 混在になるため、 leak 判定では primary source を指定すること。
 */
export function querySeries(
  targetKind: string,
  targetKey: string,
  sinceMs: number,
  source?: string,
): SeriesRow[] {
  const rows = source
    ? db().all(sql`
        SELECT sampled_at AS t, rss_bytes AS rss, heap_used_bytes AS heap_used,
               heap_total_bytes AS heap_total, external_bytes AS external, array_buffers_bytes AS array_buffers
        FROM memory_samples
        WHERE target_kind = ${targetKind} AND target_key = ${targetKey}
          AND source = ${source} AND sampled_at >= ${sinceMs}
        ORDER BY sampled_at ASC
      `)
    : db().all(sql`
        SELECT sampled_at AS t, rss_bytes AS rss, heap_used_bytes AS heap_used,
               heap_total_bytes AS heap_total, external_bytes AS external, array_buffers_bytes AS array_buffers
        FROM memory_samples
        WHERE target_kind = ${targetKind} AND target_key = ${targetKey}
          AND sampled_at >= ${sinceMs}
        ORDER BY sampled_at ASC
      `);
  return rows as unknown as SeriesRow[];
}

/** SeriesRow を leak 判定用 LeakSample へ (rss が null の行は除外)。 */
export function toLeakSamples(rows: SeriesRow[]): LeakSample[] {
  const out: LeakSample[] = [];
  for (const r of rows) {
    if (r.rss != null) out.push({ t: r.t, rss: r.rss });
  }
  return out;
}

export interface LatestTarget {
  target_kind: string;
  target_key: string;
  service_instance_id: string | null;
  source: string;
  sampled_at: number;
  rss_bytes: number | null;
  heap_used_bytes: number | null;
  heap_total_bytes: number | null;
  external_bytes: number | null;
  array_buffers_bytes: number | null;
  pid: number | null;
  detail: string | null;
}

/**
 * 各 (target_kind, target_key, source) の最新サンプル 1 件ずつを返す。
 * 同一ターゲットでも source (process/metrics 等) ごとに 1 行。
 */
export function latestPerTarget(): LatestTarget[] {
  const rows = db().all(sql`
    SELECT ms.target_kind, ms.target_key, ms.service_instance_id, ms.source, ms.sampled_at,
           ms.rss_bytes, ms.heap_used_bytes, ms.heap_total_bytes, ms.external_bytes,
           ms.array_buffers_bytes, ms.pid, ms.detail
    FROM memory_samples ms
    JOIN (
      SELECT target_kind, target_key, source, MAX(sampled_at) AS max_at
      FROM memory_samples
      GROUP BY target_kind, target_key, source
    ) latest
      ON latest.target_kind = ms.target_kind
     AND latest.target_key = ms.target_key
     AND latest.source = ms.source
     AND latest.max_at = ms.sampled_at
  `);
  return rows as unknown as LatestTarget[];
}

/**
 * leak を error_tasks に起票する。 同一ターゲットの open 系 [memory-leak] タスクがあれば
 * occurrence_count++ で dedup (低頻度・長期トレンドのため spam を避ける)。
 */
export function raiseLeakTask(params: {
  serviceInstanceId: string | null;
  dedupPrefix: string;
  summary: string;
  severity?: string;
  logExcerpt?: string;
}): 'created' | 'deduped' {
  const { serviceInstanceId, dedupPrefix, summary } = params;
  const severity = params.severity ?? 'warn';
  const like = `${dedupPrefix}%`;
  const existing = db().all(sql`
    UPDATE error_tasks
    SET occurrence_count = occurrence_count + 1,
        summary = ${summary},
        last_seen_at = unixepoch() * 1000,
        updated_at = unixepoch() * 1000
    WHERE state IN ('open', 'ack', 'snoozed')
      AND summary LIKE ${like}
      AND (
        service_instance_id = ${serviceInstanceId}
        OR (${serviceInstanceId} IS NULL AND service_instance_id IS NULL)
      )
    RETURNING id
  `) as Array<{ id: string }>;
  if (existing.length > 0) return 'deduped';

  // first_seen_at / last_seen_at は NOT NULL かつ SQL default 無しのため明示的に入れる。
  db().run(sql`
    INSERT INTO error_tasks (id, service_instance_id, severity, summary, log_excerpt, first_seen_at, last_seen_at)
    VALUES (${randomUUID()}, ${serviceInstanceId}, ${severity}, ${summary}, ${params.logExcerpt ?? null}, unixepoch() * 1000, unixepoch() * 1000)
  `);
  return 'created';
}
