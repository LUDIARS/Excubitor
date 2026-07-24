import type { ProcEntry } from '../memory/process-sampler.js';

export interface ProcessSnapshot {
  sampledAt: number;
  processes: readonly ProcEntry[];
}

export const PROCESS_SNAPSHOT_MAX_AGE_MS = 150_000;

let current: ProcessSnapshot | null = null;

/** OS 走査に成功した最新値だけを公開する。失敗時は呼ばず、直前の値を維持する。 */
export function publishProcessSnapshot(processes: readonly ProcEntry[], sampledAt = Date.now()): ProcessSnapshot {
  current = {
    sampledAt,
    processes: processes.map((process) => ({ ...process })),
  };
  return current;
}

export function getProcessSnapshot(): ProcessSnapshot | null {
  return current;
}

export function getFreshProcessSnapshot(now = Date.now()): ProcessSnapshot | null {
  if (!current || now - current.sampledAt > PROCESS_SNAPSHOT_MAX_AGE_MS) return null;
  return current;
}

/** テストと shutdown 後の再 bootstrap 用。 */
export function clearProcessSnapshot(): void {
  current = null;
}
