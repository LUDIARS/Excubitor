import { planPermitCheck, type PermitCheck } from './reauthorization.js';

/** Tokens remain only in short-lived closures, never in operation metadata. */
const permits = new Map<string, { expiresAt: number; authorize: () => Promise<boolean> }>();

export function holdOperationPermit(id: string, expiresAt: number, authorize: () => Promise<boolean>): void {
  const now = Date.now();
  for (const [key, permit] of permits) if (permit.expiresAt <= now) permits.delete(key);
  if (permits.size >= 1000) throw new Error('operation_permit_capacity');
  permits.set(id, { expiresAt, authorize });
}

/**
 * Checks authorization right before execution. A still-valid permit is introspected again; an
 * expired (queued past its TTL) or lost permit is re-obtained through `reacquire` with the same
 * scope. Every denial carries a reason so the operation fails visibly instead of being dropped.
 */
export async function consumeOperationPermit(id: string, reacquire: () => Promise<PermitCheck>, now = Date.now()): Promise<PermitCheck> {
  const permit = permits.get(id);
  permits.delete(id);
  if (planPermitCheck(permit, now) === 'reacquire' || !permit) {
    try { return await reacquire(); }
    catch (error) { return { ok: false, reason: `reauthorization_failed: ${(error as Error).message}` }; }
  }
  try {
    return await permit.authorize() ? { ok: true } : { ok: false, reason: 'authorization_revoked' };
  } catch {
    return { ok: false, reason: 'authorization_check_failed' }; // Authority/policy failure denies execution.
  }
}

export function clearOperationPermits(): void { permits.clear(); }
