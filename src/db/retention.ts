/** liveness_history の周期剪定。ログ保持は log/parquet-compactor.ts が担う。 */
import { sql } from 'drizzle-orm';
import { createNamedLogger } from '../shared/logger.js';
import type { Catalog } from '../catalog/loader.js';
import { db } from './client.js';

const logger = createNamedLogger('excubitor.retention');

export interface RetentionLoopHandle {
  stop: () => void;
}

export interface SweepResult {
  livenessDeleted: number;
}

type RetentionConfig = Catalog['retention'];

export function sweepRetentionOnce(retention: RetentionConfig, now = Date.now()): SweepResult {
  const cutoffMs = now - retention.liveness_hours * 3_600_000;
  let livenessDeleted = 0;
  for (;;) {
    const result = db().run(sql`
      DELETE FROM liveness_history
      WHERE id IN (
        SELECT id FROM liveness_history
        WHERE probed_at < ${cutoffMs}
        LIMIT ${retention.batch_rows}
      )
    `);
    const changes = result.changes ?? 0;
    livenessDeleted += changes;
    if (changes < retention.batch_rows) return { livenessDeleted };
  }
}

export function startRetentionLoop(getCatalog: () => Catalog): RetentionLoopHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const schedule = (catalog: Catalog): void => {
    const intervalMs = Math.max(60_000, catalog.retention.interval_min * 60_000);
    timer = setTimeout(tick, intervalMs);
    timer.unref?.();
  };

  const tick = (): void => {
    if (stopped) return;
    const catalog = getCatalog();
    if (catalog.retention.enabled) {
      try {
        const result = sweepRetentionOnce(catalog.retention);
        if (result.livenessDeleted > 0) {
          logger.info({ liveness_deleted: result.livenessDeleted }, 'retention sweep');
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
