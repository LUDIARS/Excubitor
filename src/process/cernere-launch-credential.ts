import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Service } from '../catalog/loader.js';
import { createNamedLogger } from '../shared/logger.js';

const logger = createNamedLogger('excubitor.process.cernere-launch-credential');

const responseSchema = z.object({
  targetProjectKey: z.string().min(1),
  launchId: z.string().uuid(),
  clientId: z.string().min(1),
  adminUserIds: z.array(z.string().uuid()).min(1),
  issuedAt: z.string().min(1),
  idempotent: z.boolean(),
}).strict();

export interface PrepareSpawnEnvOptions {
  fetchImpl?: typeof fetch;
  launchId?: string;
  targetClientSecret?: string;
}

function requireEnv(env: Record<string, string>, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`service launch credential issuance requires env ${key}`);
  return value;
}

/**
 * Cernere発行credentialを子envへ追加し、issuer credentialは削除する。
 * cernere_launch_credentials未設定のserviceではenvを複製してそのまま返す。
 */
export async function prepareSpawnEnv(
  svc: Service,
  baseEnv: Record<string, string>,
  options: PrepareSpawnEnvOptions = {},
): Promise<Record<string, string>> {
  const config = svc.cernere_launch_credentials;
  if (!config) return { ...baseEnv };

  const cernereBaseUrl = requireEnv(baseEnv, 'CERNERE_BASE_URL').replace(/\/+$/, '');
  const issuerClientId = requireEnv(baseEnv, config.issuer_client_id_env);
  const issuerClientSecret = requireEnv(baseEnv, config.issuer_client_secret_env);
  const launchId = options.launchId ?? randomUUID();
  const targetClientSecret = options.targetClientSecret ?? randomBytes(32).toString('base64url');
  const response = await (options.fetchImpl ?? fetch)(
    `${cernereBaseUrl}/api/auth/project-launch-credential`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: issuerClientId,
        client_secret: issuerClientSecret,
        target_project_key: config.target_project,
        launch_id: launchId,
        target_client_secret: targetClientSecret,
      }),
    },
  );
  if (!response.ok) {
    // response bodyにはcredentialが含まれ得るため、失敗時もログ/例外へ展開しない。
    throw new Error(
      `Cernere launch credential issuance failed for ${svc.code}: HTTP ${response.status}`,
    );
  }

  const parsed = responseSchema.safeParse(await response.json());
  if (!parsed.success || parsed.data.targetProjectKey !== config.target_project) {
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
