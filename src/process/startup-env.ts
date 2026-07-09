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

export function requiredEnvKeysForService(svc: Service): string[] {
  const cfg = resolveServiceInfisical(svc.code, svc.infisical);
  return normalizeKeys([
    ...(svc.required_env ?? []),
    ...(cfg?.required_env ?? []),
    ...(cfg?.include ?? []),
    ...(svc.requires_secret ?? []).flatMap((req) => req.keys),
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
