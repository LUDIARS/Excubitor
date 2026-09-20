import { describe, expect, it, vi } from 'vitest';
import {
  checkProcessIdentity,
  readProcessIdentity,
  verifyProcessIdentity,
  waitForProcessIdentity,
  waitForProcessIdentityOutcome,
} from './identity.js';

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

  it('distinguishes an unreadable live PID from an exited one', async () => {
    // 生きているのに読めなかっただけの pid を死亡扱いにすると、 reaper が二重起動して
    // 稼働中の実体を落とす。 verifyProcessIdentity の null では区別がつかないので checkProcessIdentity を使う。
    const failing = vi.fn(async () => ({ ok: false, code: 1, stdout: '', stderr: 'boom' }));

    await expect(checkProcessIdentity(1234, new Date('2026-07-12T03:00:00.000Z'), {
      platform: 'win32',
      run: failing,
      isProcessAlive: () => true,
    })).resolves.toEqual({ ok: false, reason: 'unreadable' });

    await expect(checkProcessIdentity(1234, new Date('2026-07-12T03:00:00.000Z'), {
      platform: 'win32',
      run: failing,
      isProcessAlive: () => false,
    })).resolves.toEqual({ ok: false, reason: 'exited' });
  });

  it('reports a recycled PID separately from an unreadable one', async () => {
    const run = vi.fn(async () => ({
      ok: true,
      code: 0,
      stdout: '2026-07-12T04:00:00.000Z',
      stderr: '',
    }));

    await expect(checkProcessIdentity(1234, new Date('2026-07-12T03:00:00.000Z'), {
      platform: 'win32',
      run,
      toleranceMs: 1_000,
    })).resolves.toEqual({ ok: false, reason: 'recycled' });
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
      isProcessAlive: () => false,
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
      isProcessAlive: () => false,
    })).resolves.toBeNull();

    expect(run).toHaveBeenCalledTimes(3);
  });
});

// 「即死」と「照合不能」は対処が正反対 (前者は起動失敗の調査、後者は生存 pid の回収) なので、
// 呼び出し側が分岐できる形で理由を返す必要がある (design.md §17.4.4)。
describe('process identity failure reason', () => {
  const expected = new Date('2026-07-12T03:00:00.000Z');

  function waitOptions(
    run: () => Promise<{ ok: boolean; code: number | null; stdout: string; stderr: string }>,
    isProcessAlive: (pid: number) => boolean = () => true,
  ) {
    let now = 0;
    return {
      platform: 'win32' as const,
      run,
      isProcessAlive,
      toleranceMs: 1_000,
      timeoutMs: 200,
      retryIntervalMs: 100,
      now: () => now,
      sleep: async (ms: number) => { now += ms; },
    };
  }

  it('reports exited when the process is gone', async () => {
    // query failure に加えて独立した存在確認も false のときだけ「不在」と確定できる。
    const run = vi.fn(async () => ({ ok: false, code: 1, stdout: '', stderr: 'not found' }));

    await expect(waitForProcessIdentityOutcome(1234, expected, waitOptions(run, () => false)))
      .resolves.toEqual({ ok: false, reason: 'exited' });
  });

  it('reports unreadable when the OS query fails but the pid is still alive', async () => {
    // timeout・権限・PowerShell 起動失敗も非ゼロになるため、query failure だけでは exited ではない。
    const run = vi.fn(async () => ({
      ok: false,
      code: null,
      stdout: '',
      stderr: '[timeout]',
    }));

    await expect(waitForProcessIdentityOutcome(1234, expected, waitOptions(run)))
      .resolves.toEqual({ ok: false, reason: 'unreadable' });
  });

  it('reports unreadable when the independent liveness probe also fails', async () => {
    const run = vi.fn(async () => ({ ok: false, code: null, stdout: '', stderr: '[timeout]' }));
    const probeFailure = (): boolean => {
      throw new Error('access denied');
    };

    await expect(waitForProcessIdentityOutcome(1234, expected, waitOptions(run, probeFailure)))
      .resolves.toEqual({ ok: false, reason: 'unreadable' });
  });

  it('reports unreadable when the process answers but the time cannot be parsed', async () => {
    // 応答はある = pid は居る。 時刻にならないだけなので、 生存 pid の回収対象。
    const run = vi.fn(async () => ({ ok: true, code: 0, stdout: '\n', stderr: '' }));

    await expect(waitForProcessIdentityOutcome(1234, expected, waitOptions(run)))
      .resolves.toEqual({ ok: false, reason: 'unreadable' });
  });

  it('reports unreadable when a recycled PID answers with a different creation time', async () => {
    // pid は生きているが別プロセス。 これも「消えた」ではないので回収対象として扱う。
    const run = vi.fn(async () => ({
      ok: true,
      code: 0,
      stdout: '2026-07-12T09:00:00.000Z\n',
      stderr: '',
    }));

    await expect(waitForProcessIdentityOutcome(1234, expected, waitOptions(run)))
      .resolves.toEqual({ ok: false, reason: 'unreadable' });
  });

  it('returns the identity unchanged on success', async () => {
    const run = vi.fn(async () => ({
      ok: true,
      code: 0,
      stdout: '2026-07-12T03:00:00.400Z\n',
      stderr: '',
    }));

    const outcome = await waitForProcessIdentityOutcome(1234, expected, waitOptions(run));

    expect(outcome).toMatchObject({ ok: true, identity: { pid: 1234, verified: true } });
  });

  it('rejects invalid identity input without invoking an OS command', async () => {
    const run = vi.fn(async () => ({ ok: true, code: 0, stdout: '', stderr: '' }));

    await expect(waitForProcessIdentityOutcome(0, expected, waitOptions(run)))
      .resolves.toEqual({ ok: false, reason: 'unreadable' });
    expect(run).not.toHaveBeenCalled();
  });
});
