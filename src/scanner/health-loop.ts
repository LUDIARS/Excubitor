/**
 * 死活確認ループ: 全サービスの生存を短い周期で確かめ、 結果を DB と health キャッシュへ載せる。
 *
 * 1 周でやること (すべて子プロセスをほぼ起動しない):
 *   1. process_match を持つ外部起動アプリの生存 (host-process.ts、 process snapshot を流用)
 *   2. health probe (HTTP / TCP / cmd / process / port) を同時数上限付きで実行 (health.ts)
 *   3. service_instances / liveness_history を 1 トランザクションで更新 (health-state.ts)
 *   4. health キャッシュを差し替え (health-cache.ts) — 拠点間 health はここを読む
 *   5. 停止 / 復旧の通知 (downtime-alert.ts)
 *
 * git / 版 / docker のような重い棚卸しは inventory-loop.ts が別周期で持つ。
 */

import type { Catalog } from '../catalog/loader.js';
import { createNamedLogger } from '../shared/logger.js';
import { startPeriodicTask, type PeriodicTaskHandle } from '../shared/periodic.js';
import { scanHostProcesses } from './host-process.js';
import { syncHealthyServiceStates } from './health-state.js';
import { publishHealthResults } from './health-cache.js';
import { processDowntimeAlerts } from './downtime-alert.js';

/** @implements SPEC-MONITOR-LIGHTWEIGHT */

const logger = createNamedLogger('excubitor.scanner.health');

export interface HealthLoopOptions {
  getCatalog: () => Catalog;
  intervalMs: () => number;
  now?: () => number;
}

/** 死活確認を 1 周だけ実行する。 各段の失敗は記録して次の段へ進む。 */
export async function runHealthPass(catalog: Catalog, intervalMs: number, now: () => number = Date.now): Promise<void> {
  const startedAt = now();
  try {
    await scanHostProcesses(catalog);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'host process scan failed');
  }

  const health = await syncHealthyServiceStates(catalog, { now });
  publishHealthResults({ startedAt, completedAt: now(), intervalMs, results: health.results });
  await processDowntimeAlerts(health.observations);
}

export function startHealthLoop(options: HealthLoopOptions): PeriodicTaskHandle {
  const now = options.now ?? Date.now;
  return startPeriodicTask({
    run: () => runHealthPass(options.getCatalog(), options.intervalMs(), now),
    intervalMs: options.intervalMs,
    onError: (err) => logger.warn({ err: (err as Error).message }, 'health pass failed'),
  });
}
