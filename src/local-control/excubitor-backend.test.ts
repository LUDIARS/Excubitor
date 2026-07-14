import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { ExcubitorBackendController } from './excubitor-backend.js';

describe('Excubitor backend controller', () => {
  it('coalesces concurrent start calls into one backend process', async () => {
    const child = fakeChild(1000, true);
    const spawnBackend = vi.fn(() => child);
    const controller = new ExcubitorBackendController({
      rootDir: process.cwd(),
      spawnBackend,
      waitUntilReady: async () => undefined,
    });

    const [first, second] = await Promise.all([controller.start(), controller.start()]);
    expect(first.pid).toBe(1000);
    expect(second.pid).toBe(1000);
    expect(spawnBackend).toHaveBeenCalledTimes(1);
    await controller.stop();
  });

  it('preserves a running detached backend when only the supervisor shuts down', async () => {
    const child = fakeChild(1004, true);
    const controller = new ExcubitorBackendController({
      rootDir: process.cwd(),
      spawnBackend: () => child,
      waitUntilReady: async () => undefined,
    });
    await controller.start();
    const unref = child.unref as ReturnType<typeof vi.fn>;
    unref.mockClear();

    await controller.preserveForSupervisorShutdown();

    expect(child.kill).not.toHaveBeenCalled();
    expect(unref).toHaveBeenCalledTimes(1);
    expect(controller.status()).toMatchObject({ state: 'running', desired_state: 'running', pid: 1004 });
    await controller.stop();
  });

  it('persists a token reservation before spawning the backend', async () => {
    const child = fakeChild(1005, true);
    const statuses: Array<{ state: string; pid: number | null; instance_token: string | null }> = [];
    const spawnBackend = vi.fn((token: string) => {
      expect(statuses.at(-1)).toMatchObject({ state: 'starting', pid: null, instance_token: token });
      return child;
    });
    const controller = new ExcubitorBackendController({
      rootDir: process.cwd(),
      spawnBackend,
      waitUntilReady: async () => undefined,
      onStatus: async (status) => {
        statuses.push({ state: status.state, pid: status.pid, instance_token: status.instance_token });
      },
    });

    await controller.start();

    expect(spawnBackend).toHaveBeenCalledTimes(1);
    expect(statuses.some((status) => status.state === 'starting' && status.pid === 1005)).toBe(true);
    await controller.stop();
  });

  it('adopts a pre-spawn launch reservation when its token appears at health', async () => {
    const spawnBackend = vi.fn(() => fakeChild(1007, true));
    const terminateAdopted = vi.fn(async () => undefined);
    const controller = new ExcubitorBackendController({
      rootDir: process.cwd(),
      spawnBackend,
      isPidAlive: (pid) => pid === 1006,
      probeHealthIdentity: async () => ({ pid: 1006, instance_token: 'reserved-token' }),
      terminateAdopted,
    });

    await expect(controller.recover({
      kind: 'excubitor-status',
      state: 'starting',
      desired_state: 'running',
      pid: null,
      restart_count: 0,
      last_exit_code: null,
      last_signal: null,
      last_error: null,
      instance_token: 'reserved-token',
    })).resolves.toMatchObject({ state: 'running', pid: 1006, instance_token: 'reserved-token' });

    expect(spawnBackend).not.toHaveBeenCalled();
    await controller.stop();
    expect(terminateAdopted).toHaveBeenCalledWith(1006);
  });

  it('recovers from a readiness failure after terminating the failed child', async () => {
    const first = fakeChild(1001, true);
    const second = fakeChild(1002, true);
    const children = [first, second];
    const waitUntilReady = vi.fn()
      .mockRejectedValueOnce(new Error('not ready'))
      .mockResolvedValue(undefined);
    const controller = new ExcubitorBackendController({
      rootDir: process.cwd(),
      spawnBackend: () => children.shift()!,
      waitUntilReady,
      stopTimeoutMs: 20,
      forceStopTimeoutMs: 20,
      restartBaseDelayMs: 60_000,
    });

    await expect(controller.start()).rejects.toThrow('not ready');
    await expect(controller.start()).resolves.toMatchObject({ state: 'running', pid: 1002 });
    await controller.stop();
  });

  it('durably publishes the spawned identity before readiness', async () => {
    const child = fakeChild(1003, true);
    const persisted: Array<{
      state: string;
      desiredState: string;
      pid: number | null;
      token: string | null;
    }> = [];
    let releaseIdentityWrite = (): void => undefined;
    let markIdentityWriteStarted = (): void => undefined;
    const identityWriteStarted = new Promise<void>((resolve) => { markIdentityWriteStarted = resolve; });
    const waitUntilReady = vi.fn(async () => undefined);
    const controller = new ExcubitorBackendController({
      rootDir: process.cwd(),
      spawnBackend: () => child,
      waitUntilReady,
      onStatus: async (status) => {
        if (status.state === 'starting' && status.pid === 1003) {
          markIdentityWriteStarted();
          await new Promise<void>((resolve) => { releaseIdentityWrite = resolve; });
        }
        persisted.push({
          state: status.state,
          desiredState: status.desired_state,
          pid: status.pid ?? null,
          token: status.instance_token ?? null,
        });
      },
    });

    const starting = controller.start();
    await identityWriteStarted;

    expect(waitUntilReady).not.toHaveBeenCalled();
    expect(persisted[0]).toMatchObject({
      state: 'starting',
      desiredState: 'running',
      pid: null,
    });
    expect(persisted[0]?.token).toEqual(expect.any(String));
    releaseIdentityWrite();
    await expect(starting).resolves.toMatchObject({ state: 'running', pid: 1003 });

    expect(persisted[1]).toMatchObject({
      state: 'starting',
      desiredState: 'running',
      pid: 1003,
    });
    expect(persisted[1]?.token).toBe(persisted[0]?.token);
    expect(persisted[2]).toMatchObject({ state: 'running', pid: 1003, token: persisted[0]?.token });
    await controller.stop();
  });

  it('terminates a spawned backend when identity persistence fails', async () => {
    const child = fakeChild(1004, true);
    const waitUntilReady = vi.fn(async () => undefined);
    const controller = new ExcubitorBackendController({
      rootDir: process.cwd(),
      spawnBackend: () => child,
      waitUntilReady,
      restartBaseDelayMs: 60_000,
      onStatus: async (status) => {
        if (status.state === 'starting' && status.pid === 1004) throw new Error('identity write failed');
      },
    });

    await expect(controller.start()).rejects.toThrow('identity write failed');

    expect(waitUntilReady).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    await controller.stop();
  });

  it('adopts only a matching persisted backend identity and can stop it', async () => {
    const terminateAdopted = vi.fn(async () => undefined);
    const controller = new ExcubitorBackendController({
      rootDir: process.cwd(),
      isPidAlive: () => true,
      probeHealthIdentity: async () => ({ pid: 2001, instance_token: 'token-1' }),
      terminateAdopted,
    });

    await expect(controller.adopt({
      kind: 'excubitor-status',
      state: 'running',
      desired_state: 'running',
      pid: 2001,
      restart_count: 0,
      last_exit_code: null,
      last_signal: null,
      last_error: null,
      instance_token: 'token-1',
    })).resolves.toBe(true);
    await expect(controller.stop()).resolves.toMatchObject({ state: 'stopped', pid: null });
    expect(terminateAdopted).toHaveBeenCalledWith(2001);
  });

  it('preserves a persisted stopped intent without starting a replacement', async () => {
    const spawnBackend = vi.fn(() => fakeChild(2004, true));
    const controller = new ExcubitorBackendController({
      rootDir: process.cwd(),
      spawnBackend,
    });

    await expect(controller.recover({
      kind: 'excubitor-status',
      state: 'stopped',
      desired_state: 'stopped',
      pid: null,
      restart_count: 2,
      last_exit_code: 0,
      last_signal: null,
      last_error: null,
      instance_token: null,
    })).resolves.toMatchObject({
      state: 'stopped',
      desired_state: 'stopped',
      pid: null,
      restart_count: 2,
    });
    expect(spawnBackend).not.toHaveBeenCalled();
  });

  it('finishes stopping a matching orphan without starting a replacement', async () => {
    const spawnBackend = vi.fn(() => fakeChild(2005, true));
    const terminateAdopted = vi.fn(async () => undefined);
    const controller = new ExcubitorBackendController({
      rootDir: process.cwd(),
      spawnBackend,
      isPidAlive: () => true,
      probeHealthIdentity: async () => ({ pid: 2004, instance_token: 'stopping-token' }),
      terminateAdopted,
    });

    await expect(controller.recover({
      kind: 'excubitor-status',
      state: 'stopping',
      desired_state: 'stopped',
      pid: 2004,
      restart_count: 0,
      last_exit_code: null,
      last_signal: null,
      last_error: null,
      instance_token: 'stopping-token',
    })).resolves.toMatchObject({ state: 'stopped', desired_state: 'stopped', pid: null });

    expect(terminateAdopted).toHaveBeenCalledWith(2004);
    expect(spawnBackend).not.toHaveBeenCalled();
  });

  it('fails closed when a live adopted PID health identity changes', async () => {
    vi.useFakeTimers();
    try {
      let healthIdentity = { pid: 2002, instance_token: 'token-2' };
      const replacement = fakeChild(2003, true);
      const spawnBackend = vi.fn(() => replacement);
      const terminateAdopted = vi.fn(async () => undefined);
      const controller = new ExcubitorBackendController({
        rootDir: process.cwd(),
        isPidAlive: () => true,
        probeHealthIdentity: async () => healthIdentity,
        terminateAdopted,
        spawnBackend,
        waitUntilReady: async () => undefined,
        adoptedMonitorIntervalMs: 10,
        adoptedIdentityFailureThreshold: 1,
        restartBaseDelayMs: 1,
      });
      await controller.adopt({
        kind: 'excubitor-status',
        state: 'running',
        desired_state: 'running',
        pid: 2002,
        restart_count: 0,
        last_exit_code: null,
        last_signal: null,
        last_error: null,
        instance_token: 'token-2',
      });

      healthIdentity = { pid: 9999, instance_token: 'foreign-token' };
      await vi.advanceTimersByTimeAsync(11);
      await vi.advanceTimersByTimeAsync(2);

      expect(terminateAdopted).not.toHaveBeenCalled();
      expect(spawnBackend).not.toHaveBeenCalled();
      expect(controller.status()).toMatchObject({ state: 'crashed', pid: 2002 });
      await controller.preserveForSupervisorShutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('increases spawn-failure restart backoff', async () => {
    vi.useFakeTimers();
    try {
      const spawnBackend = vi.fn(() => {
        throw new Error('spawn denied');
      });
      const controller = new ExcubitorBackendController({
        rootDir: process.cwd(),
        spawnBackend,
        restartBaseDelayMs: 100,
        restartMaxDelayMs: 1_000,
      });

      await expect(controller.start()).rejects.toThrow('spawn denied');
      expect(controller.status().restart_count).toBe(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(spawnBackend).toHaveBeenCalledTimes(2);
      expect(controller.status().restart_count).toBe(2);
      await vi.advanceTimersByTimeAsync(199);
      expect(spawnBackend).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(spawnBackend).toHaveBeenCalledTimes(3);
      await controller.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('restarts an owned backend only after consecutive health identity failures', async () => {
    vi.useFakeTimers();
    try {
      const first = fakeChild(3001, true);
      const second = fakeChild(3002, true);
      const children = [first, second];
      let currentPid = 0;
      let currentToken = '';
      let healthMatches = true;
      const spawnBackend = vi.fn((token: string) => {
        const child = children.shift()!;
        currentPid = child.pid!;
        currentToken = token;
        return child;
      });
      const controller = new ExcubitorBackendController({
        rootDir: process.cwd(),
        spawnBackend,
        waitUntilReady: async () => undefined,
        probeHealthIdentity: async () => healthMatches
          ? { pid: currentPid, instance_token: currentToken }
          : null,
        healthMonitorIntervalMs: 10,
        healthFailureThreshold: 2,
        restartBaseDelayMs: 1,
      });
      await controller.start();

      healthMatches = false;
      await vi.advanceTimersByTimeAsync(10);
      healthMatches = true;
      await vi.advanceTimersByTimeAsync(10);
      expect(spawnBackend).toHaveBeenCalledTimes(1);

      healthMatches = false;
      await vi.advanceTimersByTimeAsync(20);
      healthMatches = true;
      await vi.advanceTimersByTimeAsync(2);

      expect(first.kill).toHaveBeenCalledWith('SIGTERM');
      expect(spawnBackend).toHaveBeenCalledTimes(2);
      expect(controller.status()).toMatchObject({ state: 'running', pid: 3002 });
      await controller.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let an in-flight health probe kill a backend after preserve is requested', async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild(3003, true);
      let resolveProbe = (_value: { pid: number; instance_token: string } | null): void => undefined;
      let markProbeStarted = (): void => undefined;
      const probeStarted = new Promise<void>((resolve) => { markProbeStarted = resolve; });
      const controller = new ExcubitorBackendController({
        rootDir: process.cwd(),
        spawnBackend: () => child,
        waitUntilReady: async () => undefined,
        probeHealthIdentity: () => new Promise((resolve) => {
          resolveProbe = resolve;
          markProbeStarted();
        }),
        healthMonitorIntervalMs: 10,
        healthFailureThreshold: 1,
      });
      await controller.start();
      const kill = child.kill as ReturnType<typeof vi.fn>;
      kill.mockClear();

      await vi.advanceTimersByTimeAsync(10);
      await probeStarted;
      const preserving = controller.preserveForSupervisorShutdown();
      resolveProbe(null);
      await preserving;
      await vi.advanceTimersByTimeAsync(1);

      expect(kill).not.toHaveBeenCalled();
      expect(controller.status()).toMatchObject({ state: 'running', pid: 3003 });
      await controller.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

function fakeChild(pid: number, exitOnSignal: boolean): ChildProcess {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: ReturnType<typeof vi.fn>;
    unref: ReturnType<typeof vi.fn>;
  };
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn((signal: NodeJS.Signals = 'SIGTERM') => {
    if (exitOnSignal) {
      queueMicrotask(() => {
        child.signalCode = signal;
        child.emit('exit', null, signal);
      });
    }
    return true;
  });
  child.unref = vi.fn();
  return child as unknown as ChildProcess;
}
