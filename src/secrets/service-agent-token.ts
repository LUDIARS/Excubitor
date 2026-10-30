/**
 * サービスごとの secret-agent token。 token 自体がサービスコードを持ち、 resolve できるのはそのサービスの
 * binding だけになる (旧来の全サービス共通 token では、 呼び出し側が service を自己申告できた)。
 *
 * 形式: `exsa1.<service code>.<base64url(HMAC-SHA256(subkey, code))>`
 *   subkey = HMAC-SHA256(master 鍵, 'excubitor/secret-agent/service-token/v1')
 * master 鍵は KeyStore (DPAPI / 0600) にあるので、 token は保存せずに必要なたびに導出できる。
 * Excubitor が起動するサービスには env `EXCUBITOR_AGENT_TOKEN` として渡す (process/inject.ts)。
 * Excubitor の外で起動するサービスには管理者が `npm run agent-token -- service <code>` で渡す。
 *
 * @implements SPEC-SECURITY-AGENT-TOKEN-SPLIT
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { masterSecret } from './master-key.js';

export const SERVICE_TOKEN_PREFIX = 'exsa1.';
const SERVICE_CODE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const SUBKEY_LABEL = 'excubitor/secret-agent/service-token/v1';

function mac(code: string, secret: string): string {
  const subkey = createHmac('sha256', secret).update(SUBKEY_LABEL).digest();
  return createHmac('sha256', subkey).update(code).digest('base64url');
}

export function isServiceCode(code: string): boolean {
  return SERVICE_CODE.test(code);
}

export function serviceAgentToken(code: string, secret: string = masterSecret()): string {
  if (!isServiceCode(code)) throw new Error('invalid service code for a secret-agent token');
  return `${SERVICE_TOKEN_PREFIX}${code}.${mac(code, secret)}`;
}

export function looksLikeServiceAgentToken(value: string): boolean {
  return value.startsWith(SERVICE_TOKEN_PREFIX);
}

/** 正しいサービス token ならサービスコードを返す。 それ以外は null (定数時間比較)。 */
export function verifyServiceAgentToken(token: string, secret: string = masterSecret()): string | null {
  if (!looksLikeServiceAgentToken(token)) return null;
  const rest = token.slice(SERVICE_TOKEN_PREFIX.length);
  const dot = rest.indexOf('.');
  if (dot < 1) return null;
  const code = rest.slice(0, dot);
  if (!isServiceCode(code)) return null;
  const provided = Buffer.from(rest.slice(dot + 1));
  const expected = Buffer.from(mac(code, secret));
  return provided.length === expected.length && timingSafeEqual(provided, expected) ? code : null;
}
