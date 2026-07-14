import { sql } from 'drizzle-orm';
import type { Catalog } from '../catalog/loader.js';
import { db } from '../db/client.js';
import { createNamedLogger } from '../shared/logger.js';
import {
  maybeDispatchCrashFixToConcordia,
  reconcileConcordiaDispatch,
} from './concordia-dispatch.js';

const logger = createNamedLogger('excubitor.concordia_dispatch_loop');
const DEFAULT_INTERVAL_MS = 30_000;
const STUCK_AFTER_MS = 60_000;

interface PendingDispatchRow {
  id: string;
  severity: string;
  summary: string;
  log_excerpt: string | null;
  service_code: string;
}

export interface ConcordiaDispatchLoopHandle {
  stop(): void;
}

export async function retryPendingConcordiaDispatches(
  catalog: Catalog,
  now = Date.now(),
): Promise<number> {
  const rows = db().all(sql`
    SELECT et.id, et.severity, et.summary, et.log_excerpt, s.code AS service_code
    FROM error_tasks et
    JOIN service_instances si ON si.id = et.service_instance_id
    JOIN services s ON s.id = si.service_id
    WHERE et.state IN ('open', 'ack', 'snoozed')
      AND (
        (et.auto_fix_state = 'concordia_dispatch_failed'
          AND COALESCE(et.issue_dispatch_next_at, 0) <= ${now})
        OR (et.auto_fix_state = 'concordia_dispatching'
          AND et.updated_at <= ${now - STUCK_AFTER_MS})
        OR (et.auto_fix_state IS NULL
          AND et.severity = 'fatal'
          AND s.code = 'anatomia')
      )
    ORDER BY et.updated_at ASC
    LIMIT 20
  `) as PendingDispatchRow[];

  let completed = 0;
  for (const row of rows) {
    const service = catalog.services.find((candidate) => candidate.code === row.service_code);
    if (!service) {
      logger.warn({ errorTaskId: row.id, code: row.service_code }, 'dispatch retry skipped: service missing');
      continue;
    }

    const reconciliation = await reconcileConcordiaDispatch(row.id);
    if (reconciliation === 'found') {
      completed += 1;
      continue;
    }
    if (reconciliation === 'unavailable') continue;

    const result = await maybeDispatchCrashFixToConcordia({
      errorTaskId: row.id,
      service,
      severity: row.severity,
      summary: row.summary,
      logExcerpt: row.log_excerpt,
      source: 'log',
    });
    if (result.dispatched) completed += 1;
  }
  return completed;
}

export function startConcordiaDispatchLoop(
  catalogProvider: () => Catalog,
  intervalMs = DEFAULT_INTERVAL_MS,
): ConcordiaDispatchLoopHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await retryPendingConcordiaDispatches(catalogProvider());
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'dispatch retry tick failed');
    }
    if (!stopped) {
      timer = setTimeout(() => void tick(), intervalMs);
      timer.unref?.();
    }
  };

  void tick();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
