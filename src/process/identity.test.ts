import { describe, expect, it, vi } from 'vitest';
import { readProcessIdentity, verifyProcessIdentity, waitForProcessIdentity } from './identity.js';

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

  it('reads the current identity when no persisted start time exists', async () => {
    const run = vi.fn(async () => ({
      ok: true,
      code: 0,
      stdout: '2026-08-10T00:00:00.000Z\n',
      stderr: '',
    }));

    await expect(readProcessIdentity(32456, { platform: 'win32', run })).resolves.toEqual({
      pid: 32456,
      startedAt: new Date('2026-08-10T00:00:00.000Z'),
      verified: true,
    });
  });

  it('retries a newly created process until its identity becomes readable', async () => {
    const startedAt = new Date('2026-07-12T03:00:00.000Z');
    const run = vi.fn()
      .mockResolvedValueOnce({ ok: false, code: 1, stdout: '', stderr: 'not found' })
      .mockResolvedValueOnce({
        ok: true,
        code: 0,
        stdout: '2026-07-12T03:00:00.400Z\n',
        stderr: '',
      });
    let now = 0;
    const sleep = vi.fn(async (ms: number) => { now += ms; });

    await expect(waitForProcessIdentity(1234, startedAt, {
      platform: 'win32',
      run,
      toleranceMs: 1_000,
      timeoutMs: 1_000,
      retryIntervalMs: 100,
      now: () => now,
      sleep,
    })).resolves.toMatchObject({ pid: 1234, verified: true });

    expect(run).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(100);
  });

  it('remains fail-closed when the identity never becomes readable', async () => {
    const run = vi.fn(async () => ({ ok: false, code: 1, stdout: '', stderr: 'not found' }));
    let now = 0;

    await expect(waitForProcessIdentity(1234, new Date('2026-07-12T03:00:00.000Z'), {
      platform: 'win32',
      run,
      timeoutMs: 200,
      retryIntervalMs: 100,
      now: () => now,
      sleep: async (ms) => { now += ms; },
    })).resolves.toBeNull();

    expect(run).toHaveBeenCalledTimes(3);
  });
});
