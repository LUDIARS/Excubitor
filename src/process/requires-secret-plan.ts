/**
 * `requires_secret` の解決計画 (Vault 優先)。
 *
 * Infisical は Excubitor Vault へ移行済み。要求キーのうち、そのサービスの Vault 紐付けで
 * 値が得られるものは Vault から満たし、Infisical に取りに行くのは足りないキーだけにする。
 * 全キーが Vault で揃えば `remaining` は空になり、machine identity も Infisical 呼び出しも不要。
 *
 * 純関数 (テスト可能)。値の取得・ログは呼び出し側が持つ。
 */
import type { RequiresSecret } from '../catalog/loader.js';

export interface RequiresSecretPlan {
  /** Vault で満たした要求キーと値。 */
  fromVault: Record<string, string>;
  /** Infisical から取る必要がある要求 (キーは Vault に無いものだけに絞った)。 */
  remaining: RequiresSecret[];
}

export function planRequiresSecret(
  requests: readonly RequiresSecret[],
  vaultEnv: Readonly<Record<string, string>>,
): RequiresSecretPlan {
  const fromVault: Record<string, string> = {};
  const remaining: RequiresSecret[] = [];
  for (const req of requests) {
    const missing: string[] = [];
    for (const key of req.keys) {
      const value = Object.hasOwn(vaultEnv, key) ? vaultEnv[key] : undefined;
      if (value !== undefined) fromVault[key] = value;
      else missing.push(key);
    }
    if (missing.length > 0) remaining.push({ ...req, keys: missing });
  }
  return { fromVault, remaining };
}
