/**
 * append-only テーブルの retention 剪定ループ。
 *
 * service_instance_logs (プロセスログ) と liveness_history (死活履歴) は書きっぱなしで
 * 削除経路が無く、 DB 肥大 (実測 477MB / 計 170万行) → backend RSS 増の主因になっていた。
 * memory_samples は memory/collector.ts が毎 tick 剪定するのでここでは扱わない。
 *
 * 削除はバッチ (id IN (... LIMIT n)) で刻み、 書き込みロックの長期保持を避ける。
 * ファイルサイズ自体は VACUUM しない限り縮まないが、 空きページ再利用で成長は止まる。
 */

import { sql } from 'drizzle-orm';
import { createNamedLogger } from '../shared/logger.js';
import { db } from './client.js';
import type { Catalog } from '../catalog/loader.js';

const logger = createNamedLogger('excubitor.retention');

export interface RetentionLoopHandle {
  stop: () => void;
}

export interface SweepResult {
  logsDeleted: number;
  livenessDeleted: number;
}

type RetentionConfig = Catalog['retention'];

/** 1 回の剪定。 cutoff より古い行をバッチ削除して削除行数を返す。 */
export function sweepRetentionOnce(retention: RetentionConfig, now = Date.now()): SweepResult {
  const logsDeleted = batchDelete(
    'service_instance_logs',
    'ts',
    now - retention.logs_hours * 3_600_000,
    retention.batch_rows,
  );
  const livenessDeleted = batchDelete(
    'liveness_history',
    'probed_at',
    now - retention.liveness_hours * 3_600_000,
    retention.batch_rows,
  );
  return { logsDeleted, livenessDeleted };
}

function batchDelete(table: string, tsColumn: string, cutoffMs: number, batchRows: number): number {
  let total = 0;
  for (;;) {
    const res = db().run(sql`
      DELETE FROM ${sql.raw(table)}
      WHERE id IN (
        SELECT id FROM ${sql.raw(table)}
        WHERE ${sql.raw(tsColumn)} < ${cutoffMs}
        LIMIT ${batchRows}
      )
    `);
    const changes = res.changes ?? 0;
    total += changes;
    if (changes < batchRows) return total;
  }
}

/** 周期剪定ループ (memory/loop.ts と同型: 起動直後 1 回 → interval)。 */
export function startRetentionLoop(getCatalog: () => Catalog): RetentionLoopHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const schedule = (catalog: Catalog): void => {
    const intervalMs = Math.max(60_000, (catalog.retention?.interval_min ?? 60) * 60_000);
    timer = setTimeout(tick, intervalMs);
    timer.unref?.();
  };

  const tick = (): void => {
    if (stopped) return;
    const catalog = getCatalog();
    // テスト fixture 等、 Zod を通らない cast 由来の catalog は retention を欠くことが
    // あるため防御する (通常経路は loadCatalog() が既定値を埋める)。
    if (catalog.retention?.enabled) {
      try {
        const r = sweepRetentionOnce(catalog.retention);
        if (r.logsDeleted > 0 || r.livenessDeleted > 0) {
          logger.info(
            { logs_deleted: r.logsDeleted, liveness_deleted: r.livenessDeleted },
            'retention sweep',
          );
        }
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'retention sweep failed');
      }
    }
    if (!stopped) schedule(catalog);
  };

  tick();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
