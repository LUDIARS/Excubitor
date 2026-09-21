/**
 * 監視ループの入口。 周期の違う 2 本を束ねる:
 *   - 死活確認 (health-loop.ts): 既定 60 秒。 probe は安く、 子プロセスをほぼ起動しない
 *   - 棚卸し (inventory-loop.ts): 既定 5 分。 git / 版 / docker
 *
 * 以前は 1 本の 5 分ループで全部を回していた。 git を 1 サービスあたり 6 回起動しており
 * (source git と disk version で重複)、 死活が 5 分遅れる割に 1 周が重かった。
 * 周期は excubitor.config.yaml の `monitor:` で変えられ、 catalog reload に追随する。
 */

import type { Catalog } from '../catalog/loader.js';
import { startHealthLoop } from './health-loop.js';
import { startInventoryLoop } from './inventory-loop.js';

/** @implements SPEC-MONITOR-LIGHTWEIGHT */

export const DEFAULT_HEALTH_INTERVAL_SEC = 60;
export const DEFAULT_INVENTORY_INTERVAL_SEC = 300;

export interface ScannerHandle {
  stop: () => void;
}

export interface MonitorIntervals {
  healthMs: number;
  inventoryMs: number;
}

/** catalog の monitor 設定から周期を解決する (設定が無い部分は既定値)。 */
export function monitorIntervals(catalog: Pick<Catalog, 'monitor'>): MonitorIntervals {
  const monitor = catalog.monitor;
  return {
    healthMs: (monitor?.health_interval_sec ?? DEFAULT_HEALTH_INTERVAL_SEC) * 1000,
    inventoryMs: (monitor?.inventory_interval_sec ?? DEFAULT_INVENTORY_INTERVAL_SEC) * 1000,
  };
}

export function startScannerLoop(getCatalog: () => Catalog): ScannerHandle {
  const health = startHealthLoop({
    getCatalog,
    intervalMs: () => monitorIntervals(getCatalog()).healthMs,
  });
  const inventory = startInventoryLoop({
    getCatalog,
    intervalMs: () => monitorIntervals(getCatalog()).inventoryMs,
  });
  return {
    stop: () => {
      health.stop();
      inventory.stop();
    },
  };
}
