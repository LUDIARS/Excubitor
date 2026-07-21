import { watch, type FSWatcher } from 'node:fs';
import { resolve } from 'node:path';
import { createNamedLogger } from '../shared/logger.js';
import { FRAGMENT_FILENAME, fragmentSignature } from './fragments.js';

const logger = createNamedLogger('excubitor.catalog');

/** 監視確立に失敗したとき polling で変化検知を補う周期。 */
const FRAGMENT_POLL_INTERVAL_MS = 15_000;

export interface CatalogWatcherHandle {
  /** 監視を止める。 停止時に debounce が保留中だったら true を返す。 */
  stop: () => boolean;
  /** 保留中だった debounce を新しい watcher 側で再アームする (reload をまたいだ取りこぼし防止)。 */
  notifyPending: () => void;
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
  let pending = false;

  const fire = () => {
    pending = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      pending = false;
      Promise.resolve(onChange()).catch((err: unknown) =>
        logger.warn({ err: (err as Error).message }, 'catalog onChange handler failed'),
      );
    }, debounceMs);
  };

  const watcher = watch(abs, { persistent: false }, () => fire());
  watcher.on('error', (err) => {
    logger.warn({ err: err.message }, 'catalog watcher error');
  });

  return {
    stop: () => {
      const wasPending = pending;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      pending = false;
      try {
        watcher.close();
      } catch {
        /* noop */
      }
      return wasPending;
    },
    notifyPending: () => fire(),
  };
}

/**
 * 各サービスリポの断片 (excubitor.catalog.yaml) 群を監視する。
 * どれか 1 つでも変わったら debounce 付きで onChange を呼ぶ。
 *
 * 新規断片の検知: 既知断片ファイルだけでなく **各リポ dir を非再帰で監視** し、
 * さらに filename フィルタで `excubitor.catalog.yaml` の出現/変更/削除だけに反応する。
 * これにより「起動後に既存リポへ新規断片を追加した」ケースも reload を待たずに検知でき、
 * かつ他ファイルの変更ノイズは拾わない。 加えて **各ルート自体** も非再帰で監視し、
 * 新規リポ dir の出現 (= 新しいクローン) を捕捉する。 recursive watch には依存しないため
 * プラットフォーム差 (Linux 非対応) や巨大ツリーの過剰イベントを避けられる。
 *
 * 確立失敗の扱い: fs.watch の同期失敗 (EMFILE/ENOSPC 等) を無言で握りつぶさず warn し、
 * 監視できなかった対象があれば polling で変化検知を補う (恒久 stale の回避)。
 */
export function watchFragments(
  roots: string[],
  repoDirs: string[],
  onChange: () => void | Promise<void>,
  debounceMs = 500,
): CatalogWatcherHandle {
  let timer: NodeJS.Timeout | undefined;
  let pending = false;
  const watchers: FSWatcher[] = [];
  let pollTimer: NodeJS.Timeout | undefined;
  let hadEstablishFailure = false;

  const fire = () => {
    pending = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      pending = false;
      Promise.resolve(onChange()).catch((err: unknown) =>
        logger.warn({ err: (err as Error).message }, 'fragment onChange handler failed'),
      );
    }, debounceMs);
  };

  // filterName を渡すと、 その名前のエントリが変化したときだけ fire する (dir 内ノイズ除去)。
  // filename が取れない環境 (null) は保守的に fire する。
  const tryWatch = (target: string, kind: string, filterName?: string): boolean => {
    try {
      const w = watch(target, { persistent: false }, (_event, filename) => {
        if (!filterName) return fire();
        const name = typeof filename === 'string' ? filename : filename?.toString();
        if (name == null || name === filterName) fire();
      });
      w.on('error', (err) =>
        logger.warn({ err: err.message, target, kind }, 'fragment watcher error (runtime)'),
      );
      watchers.push(w);
      return true;
    } catch (err) {
      hadEstablishFailure = true;
      logger.warn(
        { target, kind, err: (err as Error).message, code: (err as NodeJS.ErrnoException).code },
        'fragment watcher の確立に失敗 (EMFILE/ENOSPC 等の可能性) → polling へフォールバック',
      );
      return false;
    }
  };

  // ルート自体: 新規リポ dir の出現を捕捉 (フィルタ無し、 top-level 変化は稀)。
  for (const root of roots) tryWatch(root, 'root');
  // 各リポ dir: excubitor.catalog.yaml の出現/変更/削除のみに反応する (filename フィルタ)。
  for (const dir of repoDirs) tryWatch(dir, 'repo-dir', FRAGMENT_FILENAME);

  // 監視確立に失敗した対象がある場合、 polling で変化検知を補う (恒久 stale の回避)。
  if (hadEstablishFailure) {
    const safeSig = (): string => {
      try {
        return fragmentSignature();
      } catch {
        return '';
      }
    };
    let lastSig = safeSig();
    pollTimer = setInterval(() => {
      const sig = safeSig();
      if (sig !== lastSig) {
        lastSig = sig;
        fire();
      }
    }, FRAGMENT_POLL_INTERVAL_MS);
    if (typeof pollTimer.unref === 'function') pollTimer.unref();
    logger.warn(
      { interval_ms: FRAGMENT_POLL_INTERVAL_MS },
      'fragment 監視の一部が確立できず polling フォールバックを開始',
    );
  }

  return {
    stop: () => {
      const wasPending = pending;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      pending = false;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = undefined;
      }
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          /* noop */
        }
      }
      return wasPending;
    },
    notifyPending: () => fire(),
  };
}
