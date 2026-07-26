import { watch, type FSWatcher } from 'node:fs';
import { resolve } from 'node:path';
import { createNamedLogger } from '../shared/logger.js';
import { fragmentFiles, fragmentRevision } from './fragments.js';

const logger = createNamedLogger('excubitor.catalog');

export interface CatalogWatcherHandle {
  stop: () => void;
}

export interface FragmentWatcherOptions {
  debounceMs?: number;
  /** fs.watch が失敗しても新規・変更 fragment を検出する fallback interval。 */
  pollIntervalMs?: number;
}

function scheduleChange(
  timer: NodeJS.Timeout | undefined,
  debounceMs: number,
  onChange: () => void | Promise<void>,
  failureMessage: string,
): NodeJS.Timeout {
  if (timer) clearTimeout(timer);
  return setTimeout(() => {
    Promise.resolve(onChange()).catch((error: unknown) =>
      logger.warn({ err: errorMessage(error) }, failureMessage),
    );
  }, debounceMs);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** catalog/services.yaml の変更を debounce 付きで監視する。 */
export function watchCatalog(
  relPath: string,
  onChange: () => void | Promise<void>,
  debounceMs = 500,
): CatalogWatcherHandle {
  const abs = resolve(process.cwd(), relPath);
  let timer: NodeJS.Timeout | undefined;
  let watcher: FSWatcher | null = null;

  try {
    watcher = watch(abs, { persistent: false }, () => {
      timer = scheduleChange(timer, debounceMs, onChange, 'catalog onChange handler failed');
    });
    watcher.on('error', (error) => {
      logger.warn({ err: error.message, file: abs }, 'catalog watcher error');
    });
  } catch (error) {
    logger.warn({ err: errorMessage(error), file: abs }, 'catalog watcher setup failed');
  }

  return {
    stop: () => {
      if (timer) clearTimeout(timer);
      watcher?.close();
    },
  };
}

/**
 * 実在する fragment file を 1 つずつ監視する。
 *
 * 既存 file の変更は個別 watcher が即時検出し、fragment の追加・削除 (と watch の同期失敗、
 * EMFILE/ENOSPC 等の非同期 error、通知欠落) は内容 hash polling が拾って watcher を張り直すため
 * stale のままにしない。
 *
 * discovery root を `recursive: true` で監視してはならない。root は `arsRoot()`
 * (= ワークスペース全体) であり、全リポジトリ・node_modules・.git 配下の変更通知が
 * すべて流れ込む。実測では監視するだけで **otherOps 14,600/秒・CPU 47%** を消費し、
 * 20 秒間に受け取った 12,959 件のイベントのうち `excubitor.catalog.yaml` に該当したものは
 * **0 件**だった (2026-07-26)。fragment は各リポ直下の 1 ファイルなので、そこだけを見れば足りる。
 */
export function watchFragments(
  onChange: () => void | Promise<void>,
  options: FragmentWatcherOptions = {},
): CatalogWatcherHandle {
  const debounceMs = options.debounceMs ?? 500;
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  let watchers: FSWatcher[] = [];
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let revision = fragmentRevision();

  const schedule = (): void => {
    if (stopped) return;
    timer = scheduleChange(timer, debounceMs, async () => {
      revision = fragmentRevision();
      await onChange();
    }, 'fragment onChange handler failed');
  };

  /** 現在実在する fragment file の集合へ watcher を張り直す。 */
  const rewatch = (): void => {
    for (const watcher of watchers) {
      try {
        watcher.close();
      } catch {
        /* best-effort */
      }
    }
    watchers = [];
    if (stopped) return;
    for (const file of fragmentFiles()) {
      try {
        const watcher = watch(file, { persistent: false }, () => schedule());
        watcher.on('error', (error) => {
          logger.warn(
            { err: error.message, file, fallback: 'content-hash polling' },
            'fragment watcher error',
          );
        });
        watchers.push(watcher);
      } catch (error) {
        logger.warn(
          { err: errorMessage(error), file, fallback: 'content-hash polling' },
          'fragment watcher setup failed',
        );
      }
    }
  };

  rewatch();

  const pollTimer = setInterval(() => {
    const nextRevision = fragmentRevision();
    if (nextRevision === revision) return;
    revision = nextRevision;
    // fragment が増減した可能性があるので watcher の集合を追従させる。
    rewatch();
    schedule();
  }, pollIntervalMs);
  pollTimer.unref();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      clearInterval(pollTimer);
      for (const watcher of watchers) watcher.close();
      watchers = [];
    },
  };
}
