import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Service } from '../catalog/loader.js';
import { createNamedLogger } from '../shared/logger.js';

const logger = createNamedLogger('excubitor.process.cernere-launch-credential');
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 3;

const responseSchema = z.object({
  targetProjectKey: z.string().min(1),
  launchId: z.string().uuid(),
  clientId: z.string().min(1),
  adminUserIds: z.array(z.string().uuid()).min(1),
  issuedAt: z.string().datetime(),
  idempotent: z.boolean(),
}).strict();

export interface PrepareSpawnEnvOptions {
  fetchImpl?: typeof fetch;
  launchId?: string;
  targetClientSecret?: string;
  timeoutMs?: number;
  maxAttempts?: number;
}

function requireEnv(env: Record<string, string>, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`service launch credential issuance requires env ${key}`);
  return value;
}

/**
 * Tailscale の CGNAT 帯 (100.64.0.0/10)。拠点間の通信は WireGuard で暗号化されるため、
 * 他拠点で動く Cernere へは http で直接つないでよい (2026-10-05 neco 判断: バックエンド間は Tailscale)。
 */
export function isTailscaleAddress(hostname: string): boolean {
  const octets = hostname.split('.');
  if (octets.length !== 4 || !octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255)) return false;
  return Number(octets[0]) === 100 && Number(octets[1]) >= 64 && Number(octets[1]) <= 127;
}

export function normalizeCernereBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('CERNERE_BASE_URL must be a valid absolute URL');
  }
  const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const plainHttpAllowed = isLoopback || isTailscaleAddress(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && plainHttpAllowed)) {
    throw new Error('CERNERE_BASE_URL must use HTTPS except for loopback or Tailscale (100.64.0.0/10)');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('CERNERE_BASE_URL must not contain credentials, query, or fragment');
  }
  return url.toString().replace(/\/+$/, '');
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

async function requestLaunchCredential(
  endpoint: string,
  body: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  maxAttempts: number,
  serviceCode: string,
): Promise<Response> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) return response;
      if (!isRetryableStatus(response.status) || attempt === maxAttempts) {
        throw new Error(
          `Cernere launch credential issuance failed for ${serviceCode}: HTTP ${response.status}`,
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Cernere launch credential issuance failed')) {
        throw error;
      }
      if (attempt === maxAttempts) {
        throw new Error(
          `Cernere launch credential issuance failed for ${serviceCode}: network or timeout error`,
          { cause: error },
        );
      }
    }
  }
  throw new Error(`Cernere launch credential issuance failed for ${serviceCode}`);
}

/**
 * Cernere で起動単位の credential を発行し、issuer credential を除いた子envを返す。
 * 再試行は同じ launch_id と secret を使うため、Cernere側のidempotencyと対応する。
 */
export async function prepareSpawnEnv(
  svc: Service,
  baseEnv: Record<string, string>,
  options: PrepareSpawnEnvOptions = {},
): Promise<Record<string, string>> {
  const config = svc.cernere_launch_credentials;
  if (!config) return { ...baseEnv };

  const cernereBaseUrl = normalizeCernereBaseUrl(requireEnv(baseEnv, 'CERNERE_BASE_URL'));
  const issuerClientId = requireEnv(baseEnv, config.issuer_client_id_env);
  const issuerClientSecret = requireEnv(baseEnv, config.issuer_client_secret_env);
  const launchId = options.launchId ?? randomUUID();
  const targetClientSecret = options.targetClientSecret ?? randomBytes(32).toString('base64url');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be positive');
  if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) throw new Error('maxAttempts must be positive');

  const requestBody = JSON.stringify({
    client_id: issuerClientId,
    client_secret: issuerClientSecret,
    target_project_key: config.target_project,
    launch_id: launchId,
    target_client_secret: targetClientSecret,
  });
  const response = await requestLaunchCredential(
    `${cernereBaseUrl}/api/auth/project-launch-credential`,
    requestBody,
    options.fetchImpl ?? fetch,
    timeoutMs,
    maxAttempts,
    svc.code,
  );

  let responseBody: unknown;
  try {
    responseBody = await response.json();
  } catch {
    throw new Error(`Cernere launch credential response is invalid for ${svc.code}`);
  }
  const parsed = responseSchema.safeParse(responseBody);
  if (
    !parsed.success
    || parsed.data.targetProjectKey !== config.target_project
    || parsed.data.launchId !== launchId
  ) {
    throw new Error(`Cernere launch credential response is invalid for ${svc.code}`);
  }

  const childEnv = { ...baseEnv };
  delete childEnv[config.issuer_client_id_env];
  delete childEnv[config.issuer_client_secret_env];
  childEnv.CERNERE_PROJECT_CLIENT_ID = parsed.data.clientId;
  childEnv.CERNERE_PROJECT_CLIENT_SECRET = targetClientSecret;
  childEnv.CORPUS_ADMIN_IDS = parsed.data.adminUserIds.join(',');

  logger.info({
    service: svc.code,
    targetProject: parsed.data.targetProjectKey,
    launchId: parsed.data.launchId,
    issuedAt: parsed.data.issuedAt,
    idempotent: parsed.data.idempotent,
  }, 'Cernere launch credential injected into child env');
  return childEnv;
}
