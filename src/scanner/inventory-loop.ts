/**
 * 棚卸しループ: docker コンテナ状態 / checkout の git 情報 / ディスク上の版を長めの周期で更新する。
 *
 * git 情報は走査 1 回につき checkout 単位で 1 度だけ読み、 docker scan・source git 同期・
 * disk version 同期の 3 段で共有する (git-inventory.ts)。 branch / hash は `.git` の直読みで
 * 子プロセスを起動せず、 `git status` だけが checkout 数ぶん走る。
 */

import type { Catalog } from '../catalog/loader.js';
import { createNamedLogger } from '../shared/logger.js';
import { startPeriodicTask, type PeriodicTaskHandle } from '../shared/periodic.js';
import { syncDockerInstances } from './sync.js';
import { syncSourceGitInfo } from './source-git.js';
import { syncDiskVersions } from './version-reconcile.js';
import { createGitInventory } from './git-inventory.js';

/** @implements SPEC-MONITOR-LIGHTWEIGHT */

const logger = createNamedLogger('excubitor.scanner.inventory');

export interface InventoryLoopOptions {
  getCatalog: () => Catalog;
  intervalMs: () => number;
}

/** 棚卸しを 1 周だけ実行する。 各段の失敗は記録して次の段へ進む。 */
export async function runInventoryPass(catalog: Catalog): Promise<void> {
  const startedAt = Date.now();
  const git = createGitInventory();

  try {
    const { scanned, matched } = await syncDockerInstances(catalog, git.read);
    logger.debug({ scanned, matched }, 'docker scan complete');
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'docker scan failed');
  }

  // docker scan は docker 系しか git を書かないので、 node 等の checkout も追随させる。
  try {
    const { updated, skipped } = await syncSourceGitInfo(catalog, git.read);
    logger.debug({ updated, skipped }, 'source git sync complete');
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'source git sync failed');
  }

  // health が名乗る版と突き合わせる「ディスク側」。
  try {
    const { updated } = await syncDiskVersions(catalog, git.read);
    logger.debug({ updated }, 'disk version sync complete');
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'disk version sync failed');
  }

  logger.debug({ duration_ms: Date.now() - startedAt, git_status_runs: git.dirtyChecks() }, 'inventory pass complete');
}

export function startInventoryLoop(options: InventoryLoopOptions): PeriodicTaskHandle {
  return startPeriodicTask({
    run: () => runInventoryPass(options.getCatalog()),
    intervalMs: options.intervalMs,
    onError: (err) => logger.warn({ err: (err as Error).message }, 'inventory pass failed'),
  });
}
