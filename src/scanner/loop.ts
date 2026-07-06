import { sql } from 'drizzle-orm';
import { createNamedLogger } from '../shared/logger.js';
import { db } from '../db/client.js';
import { syncDockerInstances } from './sync.js';
import { scanHostProcesses } from './host-process.js';
import { syncHealthyServiceStates } from './health-state.js';
import { type Catalog } from '../catalog/loader.js';
import { ensureTail, stopTail, isTailingService } from '../log/docker-tail.js';

const logger = createNamedLogger('excubitor.scanner');

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
      let dockerScanOk = false;
      try {
        const { scanned, matched } = await syncDockerInstances(catalog);
        dockerScanOk = true;
        logger.debug({ scanned, matched }, 'docker scan complete');
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'docker scan failed');
      }

      // host プロセススキャン (#91): runtime=app 等の process_match で外部起動の生存を反映。
      try {
        await scanHostProcesses(catalog);
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'host process scan failed');
      }

      // running 中の docker サービスだけに docker logs -f を張めE(DB の state を見る)
      try {
        await syncHealthyServiceStates(catalog);
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'health state scan failed');
      }

      if (!dockerScanOk) {
        if (!stopped) timer = setTimeout(tick, intervalMs);
        return;
      }

      const runningRows = db().all(sql`
        SELECT s.code
        FROM services s
        JOIN service_instances si ON si.service_id = s.id
        WHERE s.is_active = 1 AND si.state = 'running'
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
      logger.warn({ err: (err as Error).message }, 'scanner tick failed');
    }
    if (!stopped) {
      timer = setTimeout(tick, intervalMs);
    }
  };

  // 起動直後に 1 囁E+ 以征Einterval
  void tick();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}


