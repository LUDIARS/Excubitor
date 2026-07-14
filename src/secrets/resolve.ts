/**
 * サービスコード → resolved secret map。
 *
 * secret-agent (常駐 resolve) と、 既存の spawn inject 双方が使える解決ロジック。
 * Excubitor 自身の machine identity で Infisical を引き、 service の Infisical マッピング
 * (config-store 優先 / catalog fallback) を適用して env map を返す。
 */

import { readIdentity, fetchProjectSecrets, toEnvMap } from './infisical.js';
import { resolveServiceInfisical, type ServiceInfisical } from './config-store.js';

export type ResolveError = 'no_mapping' | 'no_identity' | 'fetch_failed';

export type ResolveResult =
  | { ok: true; secrets: Record<string, string>; projectId: string; environment: string }
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

/**
 * サービスの secret を解決する。
 * @param code        サービスコード
 * @param catalogInfisical catalog 由来の infisical 設定 (config-store に上書きが無い場合の fallback)
 * @param keys        返すキーを絞る (任意。 prefix 適用後のキー名)
 */
export async function resolveServiceSecrets(
  code: string,
  catalogInfisical?: ServiceInfisical,
  keys?: string[],
): Promise<ResolveResult> {
  const cfg = resolveServiceInfisical(code, catalogInfisical);
  if (!cfg) {
    return { ok: false, code: 'no_mapping', message: `service ${code} has no Infisical mapping` };
  }
  const id = readIdentity();
  if (!id) {
    return {
      ok: false,
      code: 'no_identity',
      message: 'Excubitor has no machine identity (INFISICAL_SITE_URL / CLIENT_ID / CLIENT_SECRET)',
    };
  }
  try {
    const secrets = await fetchProjectSecrets(id, cfg.project_id, cfg.environment);
    const env = toEnvMap(secrets, { prefix: cfg.prefix, include: cfg.include, exclude: cfg.exclude });
    return {
      ok: true,
      secrets: filterKeys(env, keys),
      projectId: cfg.project_id,
      environment: cfg.environment,
    };
  } catch (err) {
    return { ok: false, code: 'fetch_failed', message: (err as Error).message };
  }
}
