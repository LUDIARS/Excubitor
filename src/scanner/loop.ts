import { sql } from 'drizzle-orm';
import pino from 'pino';
import { db } from '../db/client.js';
import { syncDockerInstances } from './sync.js';
import { type Catalog } from '../catalog/loader.js';
import { ensureTail, stopTail, isTailingService } from '../log/docker-tail.js';

const logger = pino({ name: 'excubitor.scanner' });

const DEFAULT_INTERVAL_MS = 10_000;  // 10s

export interface ScannerHandle {
  stop: () => void;
}

export function startScannerLoop(catalog: Catalog, intervalMs = DEFAULT_INTERVAL_MS): ScannerHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async () => {
    if (stopped) return;
    try {
      const { scanned, matched } = await syncDockerInstances(catalog);
      logger.debug({ scanned, matched }, 'docker scan complete');

      // running 中の docker サービスだけに docker logs -f を張る (DB の state を見る)
      const runningRows = await db.execute(sql`
        SELECT s.code
        FROM services s
        JOIN service_instances si ON si.service_id = s.id
        WHERE s.is_active = TRUE AND si.state = 'running'
      `);
      const runningCodes = new Set(
        (runningRows as unknown as Array<{ code: string }>).map((r) => r.code),
      );
      for (const svc of catalog.services) {
        if (svc.runtime !== 'docker-compose' && svc.runtime !== 'docker') continue;
        if (!svc.container_names || svc.container_names.length === 0) continue;
        const primary = svc.container_names[0]!;
        const tailing = isTailingService(svc.code);
        const wantRunning = runningCodes.has(svc.code);
        if (wantRunning && !tailing) {
          ensureTail(svc.code, primary);
        } else if (!wantRunning && tailing) {
          stopTail(svc.code);
        }
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'docker scan failed');
    }
    if (!stopped) {
      timer = setTimeout(tick, intervalMs);
    }
  };

  // 起動直後に 1 回 + 以後 interval
  void tick();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
