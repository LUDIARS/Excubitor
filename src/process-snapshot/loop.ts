import { listProcesses } from '../memory/process-sampler.js';
import { createNamedLogger } from '../shared/logger.js';
import { publishProcessSnapshot } from './store.js';

const logger = createNamedLogger('excubitor.process-snapshot');
const PROCESS_SNAPSHOT_INTERVAL_MS = 60_000;

export interface ProcessSnapshotLoopHandle {
  stop: () => void;
}

/**
 * OS の全プロセス走査を所有する唯一のループ。
 * memory collector や利用サービスはこの結果を参照し、各自で WMI/ps を起動しない。
 */
export function startProcessSnapshotLoop(): ProcessSnapshotLoopHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const schedule = (): void => {
    timer = setTimeout(tick, PROCESS_SNAPSHOT_INTERVAL_MS);
    timer.unref?.();
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const processes = await listProcesses();
      if (processes) publishProcessSnapshot(processes);
      else logger.warn('process snapshot collection failed; keeping previous snapshot');
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'process snapshot collection failed');
    }
    if (!stopped) schedule();
  };

  void tick();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
