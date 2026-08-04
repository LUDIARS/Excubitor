import type { Service } from '../catalog/loader.js';
import { resolveServiceInfisical } from '../secrets/config-store.js';

export interface StartupEnvValidation {
  required: string[];
  missing: string[];
  ready: boolean;
}

function normalizeKeys(keys: Array<string | undefined> = []): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of keys) {
    const key = raw?.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * 起動前に揃っていなければならない env キー。
 *
 * `infisical.include` は **含めない**。 include は「Infisical から取得する secret を
 * 絞り込むフィルタ」であって必須宣言ではない。 隣に `infisical.required_env` がある以上、
 * include まで必須にすると required_env が意味を失い、 任意機能のためだけに列挙した
 * secret 1 本で起動できなくなる (実例: Volputas の `GLAB_SERVICE_TOKEN` は Discord
 * リレー専用で、 未設定ならリレーが degraded になるだけなのに起動が止まっていた)。
 * 必須にしたいキーは `required_env` / `infisical.required_env` に明示する。
 */
export function requiredEnvKeysForService(svc: Service): string[] {
  const cfg = resolveServiceInfisical(svc.code, svc.infisical);
  return normalizeKeys([
    ...(svc.required_env ?? []),
    ...(cfg?.required_env ?? []),
    ...(svc.requires_secret ?? []).flatMap((req) => req.keys),
    ...(svc.cernere_launch_credentials
      ? [
          svc.cernere_launch_credentials.issuer_client_id_env,
          svc.cernere_launch_credentials.issuer_client_secret_env,
        ]
      : []),
  ]);
}

export function validateStartupEnv(svc: Service, env: Record<string, string | undefined>): StartupEnvValidation {
  const required = requiredEnvKeysForService(svc);
  const missing = required.filter((key) => {
    const value = env[key];
    return value == null || value.trim() === '';
  });
  return { required, missing, ready: missing.length === 0 };
}

export function assertStartupEnv(svc: Service, env: Record<string, string | undefined>): void {
  const result = validateStartupEnv(svc, env);
  if (result.ready) return;
  throw new Error(`service ${svc.code} missing required env: ${result.missing.join(', ')}`);
}
