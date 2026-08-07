import { describe, expect, it, vi } from 'vitest';
import { clearDeclaredPort } from './port-guard.js';

function listeners(entries: Array<{ port: number; pids: number[] }>) {
  return async () => entries;
}

describe('clearDeclaredPort', () => {
  it('does nothing when the service declares no port', async () => {
    const kill = vi.fn();
    const list = vi.fn(listeners([{ port: 4240, pids: [1] }]));

    expect(await clearDeclaredPort('x', null, undefined, { kill, listeners: list })).toEqual({
      kind: 'free',
    });
    expect(list).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it('does nothing when nobody holds the declared port', async () => {
    const kill = vi.fn();

    expect(
      await clearDeclaredPort('x', 4240, undefined, {
        kill,
        listeners: listeners([{ port: 9999, pids: [7] }]),
      }),
    ).toEqual({ kind: 'free' });
    expect(kill).not.toHaveBeenCalled();
  });

  it('leaves our own managed process alone so start stays idempotent', async () => {
    const kill = vi.fn();

    expect(
      await clearDeclaredPort('x', 4240, 4321, {
        kill,
        listeners: listeners([{ port: 4240, pids: [4321] }]),
      }),
    ).toEqual({ kind: 'managed', pid: 4321 });
    expect(kill).not.toHaveBeenCalled();
  });

  it('stops an unmanaged holder and waits for the port to be released', async () => {
    // supervisor 再起動で pid 追跡を失った旧インスタンス。止めないと新プロセスが
    // EADDRINUSE で即死し、「再起動したのに古いコードが動き続ける」状態になる。
    const kill = vi.fn().mockResolvedValue(undefined);
    const list = vi
      .fn()
      .mockResolvedValueOnce([{ port: 4240, pids: [111, 222] }])
      .mockResolvedValueOnce([{ port: 4240, pids: [222] }])
      .mockResolvedValue([]);

    expect(
      await clearDeclaredPort('x', 4240, 999, {
        kill,
        listeners: list,
        sleep: async () => {},
      }),
    ).toEqual({ kind: 'reclaimed', stoppedPids: [111, 222] });
    expect(kill.mock.calls.map((call) => call[0])).toEqual([111, 222]);
  });

  it('fails closed when the port is never released', async () => {
    const kill = vi.fn().mockResolvedValue(undefined);

    await expect(
      clearDeclaredPort('x', 4240, undefined, {
        kill,
        listeners: listeners([{ port: 4240, pids: [111] }]),
        sleep: async () => {},
        timeoutMs: 1,
      }),
    ).rejects.toThrow(/still held by pid 111/);
  });

  it('keeps going when one holder cannot be stopped', async () => {
    const kill = vi
      .fn()
      .mockRejectedValueOnce(new Error('access denied'))
      .mockResolvedValue(undefined);
    const list = vi
      .fn()
      .mockResolvedValueOnce([{ port: 4240, pids: [111, 222] }])
      .mockResolvedValue([]);

    expect(
      await clearDeclaredPort('x', 4240, undefined, { kill, listeners: list, sleep: async () => {} }),
    ).toEqual({ kind: 'reclaimed', stoppedPids: [222] });
  });
});
