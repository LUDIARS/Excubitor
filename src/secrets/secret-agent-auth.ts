/**
 * secret-agent (`POST /api/v1/secrets/resolve`) の呼び出し元認証。
 *
 *   - サービス token (`exsa1.<code>.<mac>`): token のサービスだけを resolve できる。
 *   - 旧共有 token (secret-agent.token / env EXCUBITOR_AGENT_TOKEN): 移行期間の互換。 body の service を
 *     そのまま使う (旧挙動)。 EXCUBITOR_SECRET_AGENT_LEGACY_TOKEN=reject で受けなくなる。
 *
 * 拠点間の mesh token はここでは受けない (federation/mesh-token.ts)。 ただし既存拠点では mesh token が
 * 旧共有 token の値で作られるので、 旧 token を reject にするか mesh token を入れ替えるまでは分離されない。
 *
 * @implements SPEC-SECURITY-AGENT-TOKEN-SPLIT
 */

import { verifyAgentToken } from './agent-token.js';
import { looksLikeServiceAgentToken, verifyServiceAgentToken } from './service-agent-token.js';

export type SecretAgentCaller = { kind: 'service'; service: string } | { kind: 'legacy' };

export const LEGACY_TOKEN_ENV = 'EXCUBITOR_SECRET_AGENT_LEGACY_TOKEN';

/** 旧共有 token を受けるか。 既定は受ける (互換)。 `reject` で終わらせる。 */
export function legacyTokenAccepted(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[LEGACY_TOKEN_ENV] ?? '').trim().toLowerCase() !== 'reject';
}

function bearerValue(header: string | undefined | null): string {
  if (!header) return '';
  return header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : header.trim();
}

export interface SecretAgentAuthDeps {
  verifyService?: (token: string) => string | null;
  /** Authorization ヘッダ値をそのまま受ける (`Bearer xxx` / 生 token)。 */
  verifyLegacy?: (header: string) => boolean;
  legacyAccepted?: boolean;
}

export function authenticateSecretAgent(
  authorization: string | undefined | null,
  deps: SecretAgentAuthDeps = {},
): SecretAgentCaller | null {
  const token = bearerValue(authorization);
  if (!token) return null;
  if (looksLikeServiceAgentToken(token)) {
    let service: string | null;
    try { service = (deps.verifyService ?? verifyServiceAgentToken)(token); }
    catch { return null; } // master 鍵が用意できないときは通さない
    return service ? { kind: 'service', service } : null;
  }
  if (!(deps.legacyAccepted ?? legacyTokenAccepted())) return null;
  return (deps.verifyLegacy ?? verifyAgentToken)(authorization ?? '') ? { kind: 'legacy' } : null;
}

/** 要求された service に対して、 その呼び出し元が resolve してよいか。 */
export function callerMayResolve(caller: SecretAgentCaller, service: string): boolean {
  return caller.kind === 'legacy' || caller.service === service;
}
