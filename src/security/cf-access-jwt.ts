/**
 * Cloudflare Access の JWT (`Cf-Access-Jwt-Assertion`) を検証する (純関数 + 公開鍵の取得)。
 *
 * 管理 API の allowlist に公開ホストがある拠点では、 その Host で届いた要求すべてにこの検証を要求する。
 * Host / Origin はクライアントが自由に付けられるので、 Cloudflare が署名した Access の JWT だけを
 * 「Access を通ってきた」 証拠として扱う。
 *
 *   - alg は RS256 のみ。 kid で公開鍵 (https://<team>/cdn-cgi/access/certs) を引く。
 *   - iss = https://<team domain>、 aud に Excubitor の Access アプリの AUD を含むこと、 exp/nbf の時刻窓。
 *
 * @implements SPEC-SECURITY-BROWSER-ALLOWLIST
 */

import { createPublicKey, verify, type JsonWebKey, type KeyObject } from 'node:crypto';

export interface AccessJwtConfig {
  /** `<team>.cloudflareaccess.com` */
  teamDomain: string;
  /** Access アプリの AUD タグ (64 桁の 16 進)。 */
  audience: string;
}

const TEAM_DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;
const AUDIENCE = /^[a-f0-9]{64}$/;
const CLOCK_SKEW_SEC = 60;

/** runtime-config の `cloudflareAccess` を検証して取り出す。 形式が違えば null (= 未設定扱い)。 */
export function parseAccessJwtConfig(value: unknown): AccessJwtConfig | null {
  if (!value || typeof value !== 'object') return null;
  const { teamDomain, audience } = value as Record<string, unknown>;
  if (typeof teamDomain !== 'string' || typeof audience !== 'string') return null;
  const team = teamDomain.trim().toLowerCase();
  const aud = audience.trim().toLowerCase();
  return TEAM_DOMAIN.test(team) && AUDIENCE.test(aud) ? { teamDomain: team, audience: aud } : null;
}

export type AccessJwtResult = { ok: true; subject: string | null } | { ok: false; reason: string };

function decodeJson(part: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

/** JWT のヘッダから kid を読む (鍵の取得用。 検証はしない)。 */
export function accessJwtKeyId(token: string): string | null {
  const header = decodeJson(token.split('.')[0] ?? '');
  return typeof header?.kid === 'string' && header.kid.length > 0 ? header.kid : null;
}

export function verifyAccessJwt(
  token: string,
  config: AccessJwtConfig,
  key: KeyObject | null,
  nowSec: number,
): AccessJwtResult {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return { ok: false, reason: 'malformed' };
  const [encodedHeader, encodedClaims, encodedSignature] = parts as [string, string, string];
  const header = decodeJson(encodedHeader);
  const claims = decodeJson(encodedClaims);
  if (!header || !claims) return { ok: false, reason: 'malformed' };
  if (header.alg !== 'RS256') return { ok: false, reason: 'unsupported_alg' };
  if (!key) return { ok: false, reason: 'unknown_key' };
  const signed = Buffer.from(`${encodedHeader}.${encodedClaims}`, 'utf8');
  if (!verify('RSA-SHA256', signed, key, Buffer.from(encodedSignature, 'base64url'))) return { ok: false, reason: 'bad_signature' };
  if (claims.iss !== `https://${config.teamDomain}`) return { ok: false, reason: 'bad_issuer' };
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.some((value) => typeof value === 'string' && value.toLowerCase() === config.audience)) return { ok: false, reason: 'bad_audience' };
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SEC < nowSec) return { ok: false, reason: 'expired' };
  if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW_SEC > nowSec) return { ok: false, reason: 'not_yet_valid' };
  const subject = typeof claims.email === 'string' ? claims.email : typeof claims.sub === 'string' ? claims.sub : null;
  return { ok: true, subject };
}

export interface AccessKeySource {
  key(kid: string): Promise<KeyObject | null>;
}

const KEYS_TTL_MS = 60 * 60 * 1000;
const REFRESH_MIN_INTERVAL_MS = 30 * 1000;

/**
 * team の公開鍵を取得してメモリに持つ。 1 時間で取り直し、 知らない kid は 30 秒に 1 回まで取り直す
 * (鍵の更新に追従しつつ、 不正な kid で外部通信を増やさない)。 取得失敗は鍵無し = 拒否。
 */
export function createAccessKeySource(
  config: AccessJwtConfig,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): AccessKeySource {
  let keys = new Map<string, KeyObject>();
  let fetchedAt = 0;
  let attemptedAt = 0;
  let inflight: Promise<void> | null = null;

  const refresh = async (): Promise<void> => {
    attemptedAt = now();
    try {
      const response = await fetchImpl(`https://${config.teamDomain}/cdn-cgi/access/certs`, {
        redirect: 'error', signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return;
      const body = await response.json() as { keys?: Array<Record<string, unknown>> };
      const next = new Map<string, KeyObject>();
      for (const jwk of body.keys ?? []) {
        if (typeof jwk.kid !== 'string' || jwk.kty !== 'RSA') continue;
        try { next.set(jwk.kid, createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' })); }
        catch { /* skip malformed key */ }
      }
      if (next.size > 0) {
        keys = next;
        fetchedAt = now();
      }
    } catch { /* keep the previous keys; unknown kids stay rejected */ }
  };

  return {
    async key(kid: string): Promise<KeyObject | null> {
      const stale = now() - fetchedAt > KEYS_TTL_MS;
      if ((stale || !keys.has(kid)) && now() - attemptedAt >= REFRESH_MIN_INTERVAL_MS) {
        inflight ??= refresh().finally(() => { inflight = null; });
        await inflight;
      }
      return keys.get(kid) ?? null;
    },
  };
}
