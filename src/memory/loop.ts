/**
 * メモリ監視の周期ループ。 scanner/loop.ts と同型 (起動直後 1 回 → interval)。
 * catalog は live 参照 (provider) で受け取り、 file watch 後の設定変更にも追従する。
 */

import { createNamedLogger } from '../shared/logger.js';
import type { Catalog } from '../catalog/loader.js';
import { collectMemoryOnce } from './collector.js';

const logger = createNamedLogger('excubitor.memory.loop');

export interface MemoryLoopHandle {
  stop: () => void;
}

export function startMemoryLoop(getCatalog: () => Catalog): MemoryLoopHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const schedule = (catalog: Catalog): void => {
    const intervalMs = Math.max(10_000, catalog.memory_monitor.interval_sec * 1000);
    timer = setTimeout(tick, intervalMs);
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const catalog = getCatalog();
    if (catalog.memory_monitor.enabled) {
      try {
        await collectMemoryOnce(catalog);
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'memory collect failed');
      }
    }
    if (!stopped) schedule(catalog);
  };

  void tick();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
