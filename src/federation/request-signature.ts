/**
 * 拠点間要求の署名 (相互登録の確認)。
 *
 * 拠点 A が拠点 B を呼ぶとき、 A は B の agent token を Bearer に載せる (B への認証)。
 * それに加えて、 A は **自分の** agent token を鍵にして要求を HMAC-SHA256 で署名する。
 * B は自分が登録しているピア (remote_peers) の token でこの署名を検証し、 一致したピアが
 * 見つかった要求だけを通す。 B が A を登録していなければ (A の token を持っていなければ)
 * 署名を検証できないので、 相互に登録しない限り疎通しない。
 *
 * token 自体は送らない (署名だけを送る)。 再送は時刻窓と nonce で防ぐ (nonce-cache.ts)。
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** @implements SPEC-FEDERATION-MUTUAL-AUTH */

export const NODE_HEADER = 'x-excubitor-node';
export const TIMESTAMP_HEADER = 'x-excubitor-ts';
export const NONCE_HEADER = 'x-excubitor-nonce';
export const SIGNATURE_HEADER = 'x-excubitor-signature';

/** 送信側と受信側の時計のずれとして許す幅。 */
export const SIGNATURE_MAX_SKEW_MS = 5 * 60 * 1000;

export interface SignedRequestParts {
  method: string;
  /** path + query (base_url を除いた部分)。 */
  path: string;
  timestamp: number;
  nonce: string;
  /** 本文 (無ければ空文字)。 */
  body: string;
}

export function bodyDigest(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/** 署名対象の正規形 (pure)。 method は大文字、 本文は SHA-256 で畳む。 */
export function canonicalRequest(parts: SignedRequestParts): string {
  return [parts.method.toUpperCase(), parts.path, String(parts.timestamp), parts.nonce, bodyDigest(parts.body)].join('\n');
}

export function signRequest(secret: string, parts: SignedRequestParts): string {
  return createHmac('sha256', secret).update(canonicalRequest(parts), 'utf8').digest('hex');
}

export function verifyRequestSignature(secret: string, parts: SignedRequestParts, signature: string): boolean {
  const expected = Buffer.from(signRequest(secret, parts), 'hex');
  const actual = Buffer.from(signature, 'hex');
  // 長さが違うと timingSafeEqual が throw するので先に落とす (hex でない値も長さで弾かれる)。
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

export function newNonce(): string {
  return randomBytes(16).toString('hex');
}

/** 送信側: 署名ヘッダを組む。 node は自拠点名 (Latin-1 しか載らないので percent-encode する)。 */
export function signatureHeaders(
  secret: string,
  node: string,
  request: { method: string; path: string; body: string },
  now = Date.now(),
  nonce = newNonce(),
): Record<string, string> {
  const parts: SignedRequestParts = { ...request, timestamp: now, nonce };
  return {
    [NODE_HEADER]: encodeURIComponent(node),
    [TIMESTAMP_HEADER]: String(now),
    [NONCE_HEADER]: nonce,
    [SIGNATURE_HEADER]: signRequest(secret, parts),
  };
}
