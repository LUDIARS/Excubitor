/**
 * 配送側の状態 (`<state>/excubitor-delivery.json`)。 Ergo の前回状態とは別ファイル。
 *
 * - 最後に日次要約を送った日と、 その後に配送先ごとに出した出来事の数
 * - 送れなかったメッセージ (次の回の最初に再送する)。 watch は出来事を 1 回しか出さないので、
 *   送信失敗で落とさないためにここへ残す
 *
 * @implements SPEC-ERGO-WATCH-DELIVERY
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { z } from 'zod';

export const DELIVERY_STATE_FILE = 'excubitor-delivery.json';

const DeliveryStateSchema = z.object({
  schema: z.literal(1),
  last_summary_date: z.string().nullable().default(null),
  since_summary: z.object({
    public: z.number().int().nonnegative().default(0),
    private: z.number().int().nonnegative().default(0),
  }).default({}),
  outbox: z.array(z.object({
    channel: z.enum(['public', 'private']),
    content: z.string(),
  })).default([]),
});

export type DeliveryState = z.infer<typeof DeliveryStateSchema>;

export function emptyDeliveryState(): DeliveryState {
  return { schema: 1, last_summary_date: null, since_summary: { public: 0, private: 0 }, outbox: [] };
}

export function readDeliveryState(stateDir: string): DeliveryState {
  const path = join(stateDir, DELIVERY_STATE_FILE);
  if (!existsSync(path)) return emptyDeliveryState();
  try {
    const parsed = DeliveryStateSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    return parsed.success ? parsed.data : emptyDeliveryState();
  } catch {
    return emptyDeliveryState();
  }
}

export function writeDeliveryState(stateDir: string, state: DeliveryState): void {
  const path = join(stateDir, DELIVERY_STATE_FILE);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(temp, path);
}

/** ローカル日付 `YYYY-MM-DD`。 */
export function localDate(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 今日の要約がまだで、 要約の時刻を過ぎていれば送る。 */
export function isSummaryDue(state: DeliveryState, now: Date, summaryHour: number): boolean {
  return state.last_summary_date !== localDate(now) && now.getHours() >= summaryHour;
}
