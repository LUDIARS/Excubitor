/**
 * 「起動直後に 1 回 → 完了してから interval 後に次」 の周期実行。
 *
 * setInterval と違い、 前の実行が終わるまで次を始めないので、 1 回が周期より長引いても
 * 実行が重ならない (重い周で監視が監視を積み上げない)。 interval は毎回読み直すので、
 * 設定 reload 後の周期変更に再起動なしで追随する。
 *
 * run の例外はここで記録して次の周へ進む (1 回の失敗で周期そのものを止めない)。
 */

/** @implements SPEC-MONITOR-LIGHTWEIGHT */

export interface PeriodicTaskHandle {
  stop: () => void;
}

export interface PeriodicTaskOptions {
  run: () => Promise<void>;
  intervalMs: () => number;
  onError: (err: unknown) => void;
  /** 最初の実行までの待ち (ms)。 既定 0 = 即時。 */
  initialDelayMs?: number;
}

export function startPeriodicTask(options: PeriodicTaskOptions): PeriodicTaskHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const schedule = (delayMs: number): void => {
    if (stopped) return;
    timer = setTimeout(() => void tick(), delayMs);
    // 監視ループだけが残っているときにプロセス終了を妨げない。
    timer.unref?.();
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await options.run();
    } catch (err) {
      options.onError(err);
    }
    schedule(Math.max(0, options.intervalMs()));
  };

  schedule(options.initialDelayMs ?? 0);

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
