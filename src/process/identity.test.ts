import { describe, expect, it, vi } from 'vitest';
import { verifyProcessIdentity } from './identity.js';

describe('process identity verification', () => {
  it('accepts the same PID only when its OS creation time matches', async () => {
    const startedAt = new Date('2026-07-12T03:00:00.000Z');
    const run = vi.fn(async () => ({
      ok: true,
      code: 0,
      stdout: '2026-07-12T03:00:00.400Z\n',
      stderr: '',
    }));

    await expect(verifyProcessIdentity(1234, startedAt, {
      platform: 'win32',
      run,
      toleranceMs: 1_000,
    })).resolves.toMatchObject({ pid: 1234, verified: true });
  });

  it('rejects a recycled PID with a different creation time', async () => {
    const run = vi.fn(async () => ({
      ok: true,
      code: 0,
      stdout: 'Sun Jul 12 04:00:00 2026\n',
      stderr: '',
    }));

    await expect(verifyProcessIdentity(1234, new Date('2026-07-12T03:00:00.000Z'), {
      platform: 'linux',
      run,
      toleranceMs: 1_000,
    })).resolves.toBeNull();
  });
});
