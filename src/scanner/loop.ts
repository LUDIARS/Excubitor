import { createNamedLogger } from '../shared/logger.js';
import { syncDockerInstances } from './sync.js';
import { scanHostProcesses } from './host-process.js';
import { syncHealthyServiceStates } from './health-state.js';
import { type Catalog } from '../catalog/loader.js';
import { processDowntimeAlerts } from './downtime-alert.js';

const logger = createNamedLogger('excubitor.scanner');

/** 全サービスの死活走査は重いので、5 分ごとにまとめて実行する。 */
export const HEALTH_SCAN_INTERVAL_MS = 5 * 60 * 1_000;

export interface ScannerHandle {
  stop: () => void;
}

export function startScannerLoop(catalog: Catalog, intervalMs = HEALTH_SCAN_INTERVAL_MS): ScannerHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async () => {
    if (stopped) return;
    try {
      try {
        const { scanned, matched } = await syncDockerInstances(catalog);
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

      try {
        const health = await syncHealthyServiceStates(catalog);
        await processDowntimeAlerts(health.observations);
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'health state scan failed');
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


