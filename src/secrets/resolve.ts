/** Resolve service-bound Vault values for the authenticated secret-agent only. */
import type { ServiceInfisical } from './config-store.js';
import { resolveVaultEnv } from '../vault/vault-inject.js';

export type ResolveError = 'no_mapping' | 'keys_not_bound' | 'fetch_failed';

export type ResolveResult =
  | { ok: true; secrets: Record<string, string>; projectId: null; environment: null }
  | { ok: false; code: ResolveError; message: string };

/** 指定キーのみに絞る (keys 未指定なら全件)。 純粋関数。 */
export function filterKeys(
  env: Record<string, string>,
  keys?: string[],
): Record<string, string> {
  if (!keys || keys.length === 0) return env;
  const want = new Set(keys);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (want.has(k)) out[k] = v;
  }
  return out;
}

/** Legacy mapping parameter is ignored; it cannot authorize keys or select a project. */
export async function resolveServiceSecrets(
  code: string,
  _catalogInfisical?: ServiceInfisical,
  keys?: string[],
): Promise<ResolveResult> {
  try {
    const env = await resolveVaultEnv(code);
    if (Object.keys(env).length === 0) {
      return { ok: false, code: 'no_mapping', message: 'service has no resolved Vault binding' };
    }
    if (keys?.some((key) => !Object.hasOwn(env, key))) {
      return { ok: false, code: 'keys_not_bound', message: 'requested keys are not bound to this service' };
    }
    return {
      ok: true,
      secrets: filterKeys(env, keys),
      projectId: null,
      environment: null,
    };
  } catch {
    // Do not expose storage/transport errors (paths, remote bodies) to consumers.
    return { ok: false, code: 'fetch_failed', message: 'service Vault resolution failed' };
  }
}
