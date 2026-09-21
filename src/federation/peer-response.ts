/**
 * 他拠点の health 応答 1 回分を「つながり状態」へ変換する (pure)。
 *
 * 相手拠点の応答は信用せず、 health-types のスキーマで検証する。 契約に合わない応答は
 * down として扱い、 中身を画面や API へ流さない。
 */

import type { PeerCallResult } from './client.js';
import { NodeHealthPayloadSchema, type PeerLinkStatus } from './health-types.js';
import type { PeerPollOutcome } from './peer-cache.js';

/** @implements SPEC-FEDERATION-HEALTH-CACHE */

export function classifyPeerResponse(
  result: PeerCallResult<unknown>,
  latencyMs: number,
): PeerPollOutcome {
  if (!result.ok) {
    const status: PeerLinkStatus = result.status === 401 || result.status === 403 ? 'unauthorized' : 'down';
    // status が null = 接続自体が成立していない (到達不能 / タイムアウト)。 遅延は意味を持たない。
    return { ok: false, status, latency_ms: result.status == null ? null : latencyMs, error: result.error, payload: null };
  }
  const parsed = NodeHealthPayloadSchema.safeParse(result.data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join('.') || 'body';
    return {
      ok: false,
      status: 'down',
      latency_ms: latencyMs,
      error: `invalid health payload (${where}: ${issue?.message ?? 'unknown'})`,
      payload: null,
    };
  }
  return { ok: true, status: 'up', latency_ms: latencyMs, error: null, payload: parsed.data };
}
