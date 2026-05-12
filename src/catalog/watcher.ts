import { watch } from 'node:fs';
import { resolve } from 'node:path';
import pino from 'pino';

const logger = pino({ name: 'excubitor.catalog' });

export interface CatalogWatcherHandle {
  stop: () => void;
}

/**
 * catalog/services.yaml の変更を debounce 付きで監視する。
 * tsx watch は src/ 以下のみを見るため、 catalog 変更を自動反映するのに必要。
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
