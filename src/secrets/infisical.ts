/**
 * Infisical secret fetch (Excubitor relay 用).
 *
 * Excubitor が「ランチャー兼 secret relay」として、 起動する子プロセスに env を
 * 配るために使う。 各サービスは自前で Infisical を叩かず、 Excubitor が一括取得して
 * spawn 時の env に注入する (Corpus env-bootstrap が想定する経路 A)。
 *
 * 認証は Excubitor 自身の machine identity (universal-auth)。 catalog の各サービスが
 * 持つ project_id + environment で project ごとに secret を引く。 REST フローは
 * Corpus server/lib/env-bootstrap.ts と同じ (login → /api/v3/secrets/raw)。
 */

import { createNamedLogger } from '../shared/logger.js';

const logger = createNamedLogger('excubitor.secrets.infisical');

export interface ExcubitorIdentity {
  siteUrl: string;
  clientId: string;
  clientSecret: string;
}

export interface InfisicalSecret {
  secretKey: string;
  secretValue: string;
}

/** Excubitor 自身の machine identity を process.env から読む。 不足なら null。 */
export function readIdentity(env: NodeJS.ProcessEnv = process.env): ExcubitorIdentity | null {
  const siteUrl = env.INFISICAL_SITE_URL?.replace(/\/$/, '');
  const clientId = env.INFISICAL_CLIENT_ID;
  const clientSecret = env.INFISICAL_CLIENT_SECRET;
  if (!siteUrl || !clientId || !clientSecret) return null;
  return { siteUrl, clientId, clientSecret };
}

export function hasIdentity(env: NodeJS.ProcessEnv = process.env): boolean {
  return readIdentity(env) !== null;
}

// access token を identity 単位で短期キャッシュ (TTL 5min)。
interface TokenCacheEntry {
  token: string;
  expiresAt: number;
}
const tokenCache = new Map<string, TokenCacheEntry>();
const TOKEN_TTL_MS = 5 * 60 * 1000;

async function login(id: ExcubitorIdentity): Promise<string> {
  const cached = tokenCache.get(id.clientId);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const res = await fetch(`${id.siteUrl}/api/v1/auth/universal-auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: id.clientId, clientSecret: id.clientSecret }),
  });
  if (!res.ok) throw new Error(`Infisical login failed: ${res.status}`);
  const { accessToken } = (await res.json()) as { accessToken: string };
  tokenCache.set(id.clientId, { token: accessToken, expiresAt: Date.now() + TOKEN_TTL_MS });
  return accessToken;
}

// project secret を (projectId, environment) 単位で短期キャッシュ (TTL 60s)。
interface SecretCacheEntry {
  secrets: InfisicalSecret[];
  expiresAt: number;
}
const secretCache = new Map<string, SecretCacheEntry>();
const SECRET_TTL_MS = 60 * 1000;

/**
 * project の全 secret を引く。 失敗は throw する (preflight / inject 側で握る)。
 */
export async function fetchProjectSecrets(
  id: ExcubitorIdentity,
  projectId: string,
  environment: string,
): Promise<InfisicalSecret[]> {
  const cacheKey = `${projectId}:${environment}`;
  const cached = secretCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.secrets;

  const token = await login(id);
  const params = new URLSearchParams({
    workspaceId: projectId,
    environment,
    secretPath: '/',
  });
  const res = await fetch(`${id.siteUrl}/api/v3/secrets/raw?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Infisical secrets fetch failed: ${res.status}`);
  const { secrets } = (await res.json()) as { secrets: InfisicalSecret[] };
  secretCache.set(cacheKey, { secrets, expiresAt: Date.now() + SECRET_TTL_MS });
  logger.info({ projectId, environment, count: secrets.length }, 'fetched project secrets');
  return secrets;
}

export interface SecretFilter {
  prefix?: string;
  include?: string[];
  exclude?: string[];
}

/**
 * include/exclude/prefix を適用して env map に変換する (pure)。
 * - include 指定があれば、 そのキーのみ採用
 * - exclude 指定があれば除外
 * - prefix があれば key に前置
 */
export function toEnvMap(secrets: InfisicalSecret[], filter: SecretFilter = {}): Record<string, string> {
  const include = filter.include ? new Set(filter.include) : null;
  const exclude = filter.exclude ? new Set(filter.exclude) : null;
  const prefix = filter.prefix ?? '';
  const out: Record<string, string> = {};
  for (const s of secrets) {
    if (include && !include.has(s.secretKey)) continue;
    if (exclude && exclude.has(s.secretKey)) continue;
    out[`${prefix}${s.secretKey}`] = s.secretValue;
  }
  return out;
}
