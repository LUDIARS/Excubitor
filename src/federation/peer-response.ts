/**
 * 他拠点の health 応答 1 回分を「つながり状態」へ変換する (pure)。
 *
 * 相手拠点の応答は信用せず、 health-types のスキーマで検証する。 契約に合わない応答は
 * down として扱い、 中身を画面や API へ流さない。
 */

import type { PeerCallResult } from './client.js';
import { FEDERATION_HEALTH_SCHEMA, NodeHealthPayloadSchema, type PeerLinkStatus } from './health-types.js';
import type { PeerPollOutcome } from './peer-cache.js';

/** @implements SPEC-FEDERATION-HEALTH-CACHE */

/** 相手がこちらを登録していないときに返すエラーコード (peer-auth.ts)。 */
const NOT_REGISTERED = 'peer_not_registered';

export function classifyPeerResponse(
  result: PeerCallResult<unknown>,
  latencyMs: number,
): PeerPollOutcome {
  if (!result.ok) {
    return {
      ok: false,
      status: failureStatus(result),
      // status が null = 接続自体が成立していない (到達不能 / タイムアウト)。 遅延は意味を持たない。
      latency_ms: result.status == null ? null : latencyMs,
      error: result.error,
      payload: null,
    };
  }
  const schema = (result.data as { schema?: unknown } | null)?.schema;
  if (schema !== FEDERATION_HEALTH_SCHEMA) {
    return {
      ok: false,
      status: 'down',
      latency_ms: latencyMs,
      error: `incompatible health schema (peer=${String(schema)}, local=${FEDERATION_HEALTH_SCHEMA}) — 両拠点の Excubitor を同じ版へ更新してください`,
      payload: null,
    };
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

function failureStatus(result: PeerCallResult<unknown>): PeerLinkStatus {
  const code = (result.data as { error?: unknown } | null)?.error;
  if (result.status === 403 && code === NOT_REGISTERED) return 'unregistered';
  if (result.status === 401 || result.status === 403) return 'unauthorized';
  return 'down';
}
