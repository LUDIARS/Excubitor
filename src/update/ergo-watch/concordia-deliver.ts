/**
 * 束を Concordia の `POST /v1/events/package-updates` へ順に送る。 Concordia は各本文を設定済みの
 * デプロイ通知チャンネルへ Bot で投稿する (送り先は社内のチャンネルなので非公開の本文も送る)。
 *
 * - 202 で `failed` が空なら済み。 `failed` があればその束以降を同じ runId のまま持ち越す
 *   (再送しても Concordia が投稿済みの添字を飛ばす)
 * - 送れない (通信失敗・503 未設定・401・5xx) ならその束以降を順序のまま持ち越す
 * - 400 (本文不正) は再送しても通らないので捨て、 診断に出して次の束へ進む
 *
 * @implements SPEC-ERGO-WATCH-DELIVERY
 */

import { concordiaHeaders, concordiaTimeoutMs, concordiaUrl } from '../../notify/concordia-endpoint.js';
import { PACKAGE_UPDATE_SOURCE, type PackageUpdateBatch } from './concordia-batches.js';

export const PACKAGE_UPDATES_PATH = '/v1/events/package-updates';

export type PostOutcome =
  | { kind: 'accepted'; delivered: number; failed: number; duplicate: boolean }
  | { kind: 'rejected'; error: string }
  | { kind: 'retry'; error: string };

export type PackageUpdatePoster = (batch: PackageUpdateBatch) => Promise<PostOutcome>;

export interface ConcordiaDeliveryResult {
  sent: number;
  /** 本文不正で捨てた束の数。 */
  dropped: number;
  /** 送れず次の回へ持ち越す束。 */
  unsent: PackageUpdateBatch[];
  error: string | null;
}

/** Concordia の受け口が受ける本文の形。 */
export function packageUpdateBody(batch: PackageUpdateBatch): string {
  return JSON.stringify({ source: PACKAGE_UPDATE_SOURCE, runId: batch.runId, messages: batch.messages });
}

export const postPackageUpdates: PackageUpdatePoster = async (batch) => {
  let response: Response;
  try {
    response = await fetch(concordiaUrl(PACKAGE_UPDATES_PATH), {
      method: 'POST',
      headers: concordiaHeaders(),
      body: packageUpdateBody(batch),
      signal: AbortSignal.timeout(concordiaTimeoutMs()),
    });
  } catch (err) {
    return { kind: 'retry', error: `concordia unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (response.status === 400) return { kind: 'rejected', error: `concordia rejected the batch (HTTP 400)` };
  if (!response.ok) {
    const reason = typeof payload?.error === 'string' ? ` ${payload.error}` : '';
    return { kind: 'retry', error: `concordia HTTP ${response.status}${reason}` };
  }
  return {
    kind: 'accepted',
    delivered: typeof payload?.delivered === 'number' ? payload.delivered : 0,
    failed: Array.isArray(payload?.failed) ? payload.failed.length : 0,
    duplicate: payload?.duplicate === true,
  };
};

export async function deliverToConcordia(
  batches: PackageUpdateBatch[],
  post: PackageUpdatePoster = postPackageUpdates,
): Promise<ConcordiaDeliveryResult> {
  const result: ConcordiaDeliveryResult = { sent: 0, dropped: 0, unsent: [], error: null };
  for (let index = 0; index < batches.length; index += 1) {
    const outcome = await post(batches[index]!);
    if (outcome.kind === 'rejected') {
      result.dropped += 1;
      result.error = outcome.error;
      continue;
    }
    if (outcome.kind === 'retry') {
      result.error = outcome.error;
      result.unsent = batches.slice(index);
      break;
    }
    result.sent += outcome.delivered;
    if (outcome.failed > 0) {
      result.error = `concordia could not post ${outcome.failed} message(s)`;
      result.unsent = batches.slice(index);
      break;
    }
  }
  return result;
}
