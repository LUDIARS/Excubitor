import { afterEach, expect, it, vi } from 'vitest';
import { clearOperationPermits, consumeOperationPermit, holdOperationPermit } from './operation-permits.js';
import { planPermitCheck } from './reauthorization.js';

const noReacquire = vi.fn(async () => ({ ok: false as const, reason: 'should_not_reacquire' }));
afterEach(() => { clearOperationPermits(); noReacquire.mockClear(); });

it('rechecks authority once and consumes the in-memory permit', async () => {
  const authorize = vi.fn(async () => true);
  holdOperationPermit('op', Date.now() + 60_000, authorize);
  expect(await consumeOperationPermit('op', noReacquire)).toEqual({ ok: true });
  expect(authorize).toHaveBeenCalledTimes(1);
  expect(noReacquire).not.toHaveBeenCalled();
  // The permit is consumed; a second check has to reacquire.
  expect(await consumeOperationPermit('op', noReacquire)).toEqual({ ok: false, reason: 'should_not_reacquire' });
});

it('denies revoked and unavailable rechecks with a reason', async () => {
  holdOperationPermit('revoked', Date.now() + 60_000, async () => false);
  holdOperationPermit('offline', Date.now() + 60_000, async () => { throw new Error('Cr unavailable'); });
  expect(await consumeOperationPermit('revoked', noReacquire)).toEqual({ ok: false, reason: 'authorization_revoked' });
  expect(await consumeOperationPermit('offline', noReacquire)).toEqual({ ok: false, reason: 'authorization_check_failed' });
});

it('reacquires authorization for a permit that expired while queued, and for a lost permit', async () => {
  const stale = vi.fn(async () => true);
  holdOperationPermit('expired', Date.now() + 60_000, stale);
  const later = Date.now() + 10 * 60_000;
  expect(await consumeOperationPermit('expired', async () => ({ ok: true }), later)).toEqual({ ok: true });
  expect(stale).not.toHaveBeenCalled(); // the expired token is never reused
  expect(await consumeOperationPermit('lost', async () => ({ ok: true }))).toEqual({ ok: true });
});

it('fails with a reason when reauthorization is refused or throws', async () => {
  holdOperationPermit('expired', 1, async () => true);
  expect(await consumeOperationPermit('expired', async () => ({ ok: false, reason: 'operation_grant_revoked' })))
    .toEqual({ ok: false, reason: 'operation_grant_revoked' });
  expect(await consumeOperationPermit('lost', async () => { throw new Error('requester offline'); }))
    .toEqual({ ok: false, reason: 'reauthorization_failed: requester offline' });
});

it('plans recheck only for an unexpired permit', () => {
  expect(planPermitCheck({ expiresAt: 2 }, 1)).toBe('recheck');
  expect(planPermitCheck({ expiresAt: 1 }, 1)).toBe('reacquire');
  expect(planPermitCheck(undefined, 1)).toBe('reacquire');
});
