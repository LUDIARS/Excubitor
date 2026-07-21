import { watch, type FSWatcher } from 'node:fs';
import { basename, resolve } from 'node:path';
import { createNamedLogger } from '../shared/logger.js';
import { FRAGMENT_FILENAME, fragmentRevision, fragmentRoots } from './fragments.js';

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
 * fragment discovery roots を安定した 1 組の watcher で監視する。
 *
 * recursive fs.watch は既存 file の変更と新規 fragment の出現を即時検出する。watch の同期失敗、
 * EMFILE/ENOSPC 等の非同期 error、通知欠落時も内容 hash polling を常時併用するため stale のままにしない。
 */
export function watchFragments(
  onChange: () => void | Promise<void>,
  options: FragmentWatcherOptions = {},
): CatalogWatcherHandle {
  const debounceMs = options.debounceMs ?? 500;
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const watchers: FSWatcher[] = [];
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

  for (const root of fragmentRoots()) {
    try {
      const watcher = watch(root, { persistent: false, recursive: true }, (_event, filename) => {
        if (filename === null || basename(filename.toString()) === FRAGMENT_FILENAME) schedule();
      });
      watcher.on('error', (error) => {
        logger.warn(
          { err: error.message, root, fallback: 'content-hash polling' },
          'fragment watcher error',
        );
      });
      watchers.push(watcher);
    } catch (error) {
      logger.warn(
        { err: errorMessage(error), root, fallback: 'content-hash polling' },
        'fragment watcher setup failed',
      );
    }
  }

  const pollTimer = setInterval(() => {
    const nextRevision = fragmentRevision();
    if (nextRevision === revision) return;
    revision = nextRevision;
    schedule();
  }, pollIntervalMs);
  pollTimer.unref();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      clearInterval(pollTimer);
      for (const watcher of watchers) watcher.close();
    },
  };
}
