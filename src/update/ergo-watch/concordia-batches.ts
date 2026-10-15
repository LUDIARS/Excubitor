/**
 * Concordia の `POST /v1/events/package-updates` へ送る束を作る (純粋関数)。
 *
 * - 本文は整形済み (伏せ字・1,900 字分割済み) のメッセージをそのまま `text` に載せ、 非公開は `private: true`
 * - 1 束は 20 件まで。 超える回は runId に `#<n>` を付けて束を分ける (Concordia は (runId, 添字) で重複を止める)
 * - runId は 1 回の実行ごとに固定し、 送れなかった束は同じ runId のまま次の回の最初に送る
 *
 * @implements SPEC-ERGO-WATCH-DELIVERY
 */

import { randomUUID } from 'node:crypto';

import type { DeliveryState } from './delivery-state.js';
import type { DeliveryMessage } from './types.js';

export const PACKAGE_UPDATE_SOURCE = 'ergo-watch';
export const PACKAGE_UPDATE_MAX_MESSAGES = 20;

export interface PackageUpdateMessage {
  text: string;
  private: boolean;
}

export interface PackageUpdateBatch {
  runId: string;
  messages: PackageUpdateMessage[];
}

/** 1 回の実行の id (`ergo-watch-<UTC 時刻>-<乱数 8 桁>`)。 */
export function newRunId(now: Date, random: () => string = randomUUID): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${PACKAGE_UPDATE_SOURCE}-${stamp}-${random().replace(/-/g, '').slice(0, 8)}`;
}

export function buildPackageUpdateBatches(runId: string, messages: DeliveryMessage[]): PackageUpdateBatch[] {
  const converted = messages.map((message) => ({ text: message.content, private: message.channel === 'private' }));
  const batches: PackageUpdateBatch[] = [];
  for (let start = 0; start < converted.length; start += PACKAGE_UPDATE_MAX_MESSAGES) {
    batches.push({ runId, messages: converted.slice(start, start + PACKAGE_UPDATE_MAX_MESSAGES) });
  }
  if (batches.length > 1) batches.forEach((batch, index) => { batch.runId = `${runId}#${index + 1}`; });
  return batches;
}

/**
 * この回に送る束: 前回送れなかった束 (runId はそのまま) → この回の束。 webhook 直送の頃に残った `outbox` は
 * この回の束の先頭へ移す。 送るものが無ければ新しい束を作らない。
 */
export function queueConcordiaBatches(
  state: DeliveryState,
  runId: string,
  messages: DeliveryMessage[],
): PackageUpdateBatch[] {
  const carried = state.concordia_outbox.map((entry) => ({ runId: entry.run_id, messages: entry.messages }));
  return [...carried, ...buildPackageUpdateBatches(runId, [...state.outbox, ...messages])];
}

export function toConcordiaOutbox(batches: PackageUpdateBatch[]): DeliveryState['concordia_outbox'] {
  return batches.map((batch) => ({ run_id: batch.runId, messages: batch.messages }));
}
