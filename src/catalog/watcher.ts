import { watch } from 'node:fs';
import { resolve } from 'node:path';
import { createNamedLogger } from '../shared/logger.js';

const logger = createNamedLogger('excubitor.catalog');

export interface CatalogWatcherHandle {
  stop: () => void;
}

/**
 * catalog/services.yaml の変更めEdebounce 付きで監視する、E
 * tsx watch は src/ 以下�Eみを見るため、Ecatalog 変更を�E動反映するのに忁E��、E
 */
export function watchCatalog(
  relPath: string,
  onChange: () => void | Promise<void>,
  debounceMs = 500,
): CatalogWatcherHandle {
  const abs = resolve(process.cwd(), relPath);
  let timer: NodeJS.Timeout | undefined;

  const watcher = watch(abs, { persistent: false }, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      Promise.resolve(onChange()).catch((err: unknown) =>
        logger.warn({ err: (err as Error).message }, 'catalog onChange handler failed'),
      );
    }, debounceMs);
  });

  watcher.on('error', (err) => {
    logger.warn({ err: err.message }, 'catalog watcher error');
  });

  return {
    stop: () => watcher.close(),
  };
}

/**
 * 各サービスリポの断片 (excubitor.catalog.yaml) 群を監視する。
 * どれか 1 つでも変わったら debounce 付きで onChange を呼ぶ。
 *
 * 注意: 既存の断片ファイルの *変更* は検知するが、 まだ watcher を張っていない
 * *新規* 断片ファイルの出現は検知しない。 reloadCatalog 側で毎回張り直すことで、
 * 何らかの reload を跨いで新規断片も監視対象に取り込む。
 */
export function watchFragments(
  files: string[],
  onChange: () => void | Promise<void>,
  debounceMs = 500,
): CatalogWatcherHandle {
  let timer: NodeJS.Timeout | undefined;
  const watchers = files.map((abs) => {
    try {
      const w = watch(abs, { persistent: false }, () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          Promise.resolve(onChange()).catch((err: unknown) =>
            logger.warn({ err: (err as Error).message }, 'fragment onChange handler failed'),
          );
        }, debounceMs);
      });
      w.on('error', (err) => logger.warn({ err: err.message, file: abs }, 'fragment watcher error'));
      return w;
    } catch {
      return null;
    }
  });

  return {
    stop: () => {
      if (timer) clearTimeout(timer);
      for (const w of watchers) w?.close();
    },
  };
}


