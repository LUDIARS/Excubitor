/** Pure plan of consumer-bound Vault requirements. Missing or blank keys must fail. */
import type { RequiresSecret } from '../catalog/loader.js';

export interface RequiresSecretPlan {
  /** Vault で満たした要求キーと値。 */
  fromVault: Record<string, string>;
  /** Vault binding または非空の値が不足している要求。 */
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
      if (value !== undefined && value.trim() !== '') fromVault[key] = value;
      else missing.push(key);
    }
    if (missing.length > 0) remaining.push({ ...req, keys: missing });
  }
  return { fromVault, remaining };
}
