import { watch, type FSWatcher } from 'node:fs';
import { resolve } from 'node:path';
import { createNamedLogger } from '../shared/logger.js';
import { FRAGMENT_FILENAME } from './fragments.js';

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
 * 何か関連する変化があれば `onChange` を呼ぶ (debounce は呼び出し側が持つ)。
 *
 * - `files`: 既存の断片ファイル。 内容 *変更* を検知する。
 * - `dirs`: リポ dir + 走査ルート。 その中に断片ファイルが *新規作成* されたら検知する
 *   (= Excubitor 起動後に追加された断片も拾う)。 dir 内の無関係な file churn で
 *   毎回 reload しないよう、 反応するのは `excubitor.catalog.yaml` 名のイベントのみ。
 *
 * debounce をここで持たない理由: reload のたびに watcher を張り直す運用だと、 内部 timer を
 * 持つと張り直し時に *発火直前の* pending timer を巻き添えで clear してしまう競合が起きる。
 * timer は呼び出し側 (張り直しを跨いで安定なスコープ) が保持する。
 */
export function watchFragments(
  files: string[],
  dirs: string[],
  onChange: () => void,
): CatalogWatcherHandle {
  const watchers: FSWatcher[] = [];

  const add = (target: string, react: (filename: string | null) => boolean): void => {
    try {
      const w = watch(target, { persistent: false }, (_event, filename) => {
        const name = typeof filename === 'string' ? filename : null;
        if (react(name)) onChange();
      });
      w.on('error', (err) => logger.warn({ err: err.message, target }, 'fragment watcher error'));
      watchers.push(w);
    } catch (err) {
      // fs.watch の同期確立失敗 (EMFILE/ENOSPC 等) を握りつぶさない。 この断片/ディレクトリは
      // 次の reload まで監視されず stale になるので、 明示的に surface する。
      logger.error(
        { target, code: (err as NodeJS.ErrnoException).code ?? null, err: (err as Error).message },
        'fragment watch establishment failed — target stays unwatched (stale) until next reload',
      );
    }
  };

  for (const abs of files) add(abs, () => true);
  // dir 監視は「断片ファイル名のイベント」だけに反応する (無関係な file churn を無視)。
  // filename 不明 (null) のときは安全側に倒して反応する。
  for (const dir of dirs) add(dir, (name) => name === null || name === FRAGMENT_FILENAME);

  return {
    stop: () => {
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          /* noop */
        }
      }
    },
  };
}


