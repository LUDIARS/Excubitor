/** @implements SPEC-EX-NETWATCH */
/**
 * 管理者権限の同期タスクが書く状態ファイルを読み、 遮断ごとの反映状況にする。
 * ファイルは同期タスクだけが書ける場所 (%ProgramData%) にあり、 Excubitor は読むだけ。
 */

import { z } from 'zod';
import type { BlockEntry } from './block-registry.js';

export const SYNC_STATUS_FORMAT = 'excubitor-netwatch-firewall-status';

const StatusSchema = z.object({
  format: z.literal(SYNC_STATUS_FORMAT),
  version: z.literal(1),
  synced_at: z.string().datetime({ offset: true }),
  applied: z.array(z.string()),
  rejected: z.array(z.object({ id: z.string(), reason: z.string() })),
  error: z.string().nullable(),
});

/** 同期タスクの状態。 missing = 状態ファイルが無い (未導入か、 まだ 1 回も動いていない)。 */
export type SyncState = 'ok' | 'missing' | 'stale' | 'error';

export interface SyncStatus {
  state: SyncState;
  reason: string | null;
  syncedAtMs: number | null;
  applied: Set<string>;
  rejected: Map<string, string>;
}

/** 反映状況。 pending = 同期タスクがまだ反映していない (次の回を待つ)。 */
export type Enforcement = 'applied' | 'pending' | 'rejected';

/** 状態ファイルを読む段階で失敗したとき。 */
export function syncStatusError(reason: string): SyncStatus {
  return { state: 'error', reason, syncedAtMs: null, applied: new Set(), rejected: new Map() };
}

export function interpretSyncStatus(text: string | null, nowMs: number, staleAfterMs: number): SyncStatus {
  const empty = { applied: new Set<string>(), rejected: new Map<string, string>() };
  if (text === null) {
    return { state: 'missing', reason: '同期タスクの状態ファイルが無い (未導入か、 まだ動いていない)', syncedAtMs: null, ...empty };
  }
  let parsed: z.infer<typeof StatusSchema>;
  try {
    parsed = StatusSchema.parse(JSON.parse(text.replace(/^\uFEFF/, '')));
  } catch (error) {
    return { state: 'error', reason: `状態ファイルを読めない: ${(error as Error).message.split('\n')[0]}`, syncedAtMs: null, ...empty };
  }
  const syncedAtMs = Date.parse(parsed.synced_at);
  const result = {
    syncedAtMs,
    applied: new Set(parsed.applied),
    rejected: new Map(parsed.rejected.map((item) => [item.id, item.reason])),
  };
  if (parsed.error) return { state: 'error', reason: parsed.error, ...result };
  if (nowMs - syncedAtMs > staleAfterMs) {
    return { state: 'stale', reason: '同期タスクがしばらく動いていない', ...result };
  }
  return { state: 'ok', reason: null, ...result };
}

export function enforcementOf(entry: BlockEntry, status: SyncStatus): { enforcement: Enforcement; reason: string | null } {
  const rejected = status.rejected.get(entry.id);
  if (rejected !== undefined) return { enforcement: 'rejected', reason: rejected };
  if (status.applied.has(entry.id)) return { enforcement: 'applied', reason: null };
  return { enforcement: 'pending', reason: null };
}
