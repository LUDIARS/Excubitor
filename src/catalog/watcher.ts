import { watch } from 'node:fs';
import { resolve } from 'node:path';
import { createNamedLogger } from '../shared/logger.js';

const logger = createNamedLogger('excubitor.catalog');

export interface CatalogWatcherHandle {
  stop: () => void;
}

/**
 * catalog/services.yaml 縺ｮ螟画峩繧・debounce 莉倥″縺ｧ逶｣隕悶☆繧九・
 * tsx watch 縺ｯ src/ 莉･荳九・縺ｿ繧定ｦ九ｋ縺溘ａ縲・catalog 螟画峩繧定・蜍募渚譏縺吶ｋ縺ｮ縺ｫ蠢・ｦ√・
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


