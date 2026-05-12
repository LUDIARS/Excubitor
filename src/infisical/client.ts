/**
 * Infisical universal-auth client.
 *
 * Credential (client_id / client_secret) と access_token は **process メモリのみ** に保持し、
 * 永続化しない (設計書 §9.3)。 server 再起動 = メモリ消失 = 再 bootstrap 必要。
 */

import pino from 'pino';

const logger = pino({ name: 'excubitor.infisical' });

interface Creds {
  site_url: string;
  client_id: string;
  client_secret: string;
}

interface Token {
  value: string;
  expires_at_ms: number;
}

let creds: Creds | null = null;
let token: Token | null = null;

export function isBootstrapped(): boolean {
  return token !== null && creds !== null;
}

export function getStatus() {
  if (!token || !creds) return { bootstrapped: false };
  return {
    bootstrapped: true,
    site_url: creds.site_url,
    expires_at: new Date(token.expires_at_ms).toISOString(),
    expires_in_sec: Math.max(0, Math.floor((token.expires_at_ms - Date.now()) / 1000)),
  };
}

export function forget(): void {
  creds = null;
  token = null;
  logger.info('credentials forgotten');
}

export async function bootstrap(input: Creds): Promise<void> {
  const url = `${input.site_url.replace(/\/$/, '')}/api/v1/auth/universal-auth/login`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: input.client_id, clientSecret: input.client_secret }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Infisical universal-auth login failed: ${res.status} ${body}`);
  }
  const data = (await res.json()) as { accessToken: string; expiresIn?: number };
  creds = input;
  const ttl = data.expiresIn ?? 3600;
  token = {
    value: data.accessToken,
    expires_at_ms: Date.now() + ttl * 1000,
  };
  logger.info({ ttl_sec: ttl, site_url: input.site_url }, 'bootstrapped');
}

async function ensureValidToken(): Promise<void> {
  if (!creds) throw new Error('Infisical not bootstrapped');
  if (token && Date.now() + 60_000 < token.expires_at_ms) return;
  // refresh: re-login with stored creds
  await bootstrap(creds);
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  await ensureValidToken();
  const url = `${creds!.site_url.replace(/\/$/, '')}${path}`;
  return fetch(url, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      Authorization: `Bearer ${token!.value}`,
      'Content-Type': 'application/json',
    },
  });
}

export async function listSecrets(opts: {
  workspaceId: string;
  environment: string;
  secretPath?: string;
}): Promise<{ secrets: Array<{ secretKey: string; secretValue: string }> }> {
  const params = new URLSearchParams({
    workspaceId: opts.workspaceId,
    environment: opts.environment,
    secretPath: opts.secretPath ?? '/',
  });
  const res = await call(`/api/v3/secrets/raw?${params}`);
  if (!res.ok) throw new Error(`listSecrets ${res.status}: ${await res.text()}`);
  return (await res.json()) as { secrets: Array<{ secretKey: string; secretValue: string }> };
}

export async function upsertSecret(opts: {
  workspaceId: string;
  environment: string;
  secretName: string;
  secretValue: string;
  secretPath?: string;
  comment?: string;
}): Promise<void> {
  // First try update (PATCH), fall back to create (POST)
  const body = {
    workspaceId: opts.workspaceId,
    environment: opts.environment,
    secretValue: opts.secretValue,
    secretPath: opts.secretPath ?? '/',
    secretComment: opts.comment,
  };
  const patch = await call(`/api/v3/secrets/raw/${encodeURIComponent(opts.secretName)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  if (patch.ok) return;
  if (patch.status === 404) {
    const post = await call(`/api/v3/secrets/raw/${encodeURIComponent(opts.secretName)}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!post.ok) throw new Error(`createSecret ${post.status}: ${await post.text()}`);
    return;
  }
  throw new Error(`updateSecret ${patch.status}: ${await patch.text()}`);
}

export async function deleteSecret(opts: {
  workspaceId: string;
  environment: string;
  secretName: string;
  secretPath?: string;
}): Promise<void> {
  const params = new URLSearchParams({
    workspaceId: opts.workspaceId,
    environment: opts.environment,
    secretPath: opts.secretPath ?? '/',
  });
  const res = await call(`/api/v3/secrets/raw/${encodeURIComponent(opts.secretName)}?${params}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(`deleteSecret ${res.status}: ${await res.text()}`);
}

/**
 * service spawn 時に env として注入するための secrets を取得して plain object に整形する。
 * include / exclude / prefix の filter は呼び出し側で行う。
 */
export async function fetchSecretsForInject(
  workspaceId: string,
  environment: string,
): Promise<Record<string, string>> {
  const list = await listSecrets({ workspaceId, environment });
  const out: Record<string, string> = {};
  for (const s of list.secrets) {
    out[s.secretKey] = s.secretValue;
  }
  return out;
}
