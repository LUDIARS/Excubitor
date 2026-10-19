/**
 * Branch-side Vault fallback decisions (pure). I/O (cache, notification) stays in
 * vault-inject.ts / vault-fallback-notify.ts.
 *
 * @implements SPEC-VAULT-CACHE-FALLBACK
 */

/**
 * - transient: HQ / Cr / mesh temporarily unreachable (no answer, timeout, 5xx, 408/429, or the
 *   local mesh auth not being deployed yet during migration).
 * - revoked: an explicit refusal (401/403, or the administrator removed this peer's policy).
 * - unbound: HQ has no binding for the service (404).
 * - rejected: any other unexpected answer (e.g. 400 or a malformed body).
 */
export type VaultFetchOutcome = 'transient' | 'revoked' | 'unbound' | 'rejected';

/** Local refusals that come from an explicit administrator decision, not an outage. */
const LOCAL_POLICY_DENIALS = ['peer_auth_not_configured'];

export function classifyVaultFetchFailure(result: { status: number | null; error: string | null }): VaultFetchOutcome {
  const { status } = result;
  if (status === 404) return 'unbound';
  if (status === 401 || status === 403) return 'revoked';
  if (status === null) {
    return LOCAL_POLICY_DENIALS.some(code => result.error === code) ? 'revoked' : 'transient';
  }
  if (status >= 500 || status === 408 || status === 429) return 'transient';
  return 'rejected';
}

export type VaultFallbackDecision =
  | { kind: 'use-cache' }
  | { kind: 'fail'; discardCache: boolean; error: string };

export function decideVaultFallback(input: {
  outcome: Exclude<VaultFetchOutcome, 'unbound'>;
  fallbackAllowed: boolean;
  hasCache: boolean;
}): VaultFallbackDecision {
  if (input.outcome === 'revoked') return { kind: 'fail', discardCache: true, error: 'vault_authorization_revoked' };
  if (input.outcome === 'rejected') return { kind: 'fail', discardCache: false, error: 'vault_authorization_unavailable' };
  if (!input.fallbackAllowed) return { kind: 'fail', discardCache: true, error: 'vault_cache_fallback_disabled' };
  if (!input.hasCache) return { kind: 'fail', discardCache: false, error: 'vault_authorization_unavailable' };
  return { kind: 'use-cache' };
}
