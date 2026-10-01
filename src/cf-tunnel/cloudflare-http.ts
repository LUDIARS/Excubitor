/**
 * Cloudflare v4 REST の共通呼び出し。envelope ({success, errors, result}) をここで畳み、
 * 呼び出し側には result だけを返す。トークンはヘッダにのみ使い、ログ・エラーに含めない (§14)。
 *
 * path は API base からの相対 (`/accounts/<id>/...` や `/zones/...`)。
 *
 * @implements SPEC-CF-TUNNEL-ROUTES (spec/feature/cf-tunnel-routes.md)
 */

import type { CfCredentials } from './credentials.js';

export const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

interface CfEnvelope<T> {
  success: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result: T;
}

/** @implements SPEC-CF-TUNNEL-ROUTES */
export async function cfRequest<T>(
  creds: CfCredentials,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${CF_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${creds.token}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // エラー文にはアカウント ID を含む path を出さない (method と末尾の種類だけ)。
  const label = `${method} ${path.replace(/[0-9a-f]{32}/gi, '<id>')}`;
  let envelope: CfEnvelope<T>;
  try {
    envelope = (await res.json()) as CfEnvelope<T>;
  } catch {
    throw new Error(`Cloudflare API ${label} → HTTP ${res.status} (非 JSON 応答)`);
  }
  if (!res.ok || !envelope.success) {
    const detail = (envelope.errors ?? [])
      .map((e) => `${e.code ?? '?'}: ${e.message ?? 'unknown'}`)
      .join('; ');
    throw new Error(`Cloudflare API ${label} → ${res.status} ${detail || '(詳細なし)'}`);
  }
  return envelope.result;
}
