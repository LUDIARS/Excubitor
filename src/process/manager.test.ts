import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Service } from '../catalog/loader.js';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  dbRun: vi.fn(),
  startProcessLog: vi.fn(() => ({ stdoutFd: 10, stderrFd: 11 })),
  stopProcessLog: vi.fn(),
  runServiceBuild: vi.fn(),
  verifyProcessIdentity: vi.fn(),
  prepareSpawnEnv: vi.fn(async (_svc: unknown, env: Record<string, string>) => env),
}));

vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('../shared/logger.js', () => ({
  createNamedLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../db/client.js', () => ({ db: () => ({ run: mocks.dbRun }) }));
vi.mock('./dev-process-md.js', () => ({ resolveDevProcessCommand: vi.fn() }));
vi.mock('../shared/exec.js', () => ({
  execCapture: vi.fn(async () => ({ ok: true, code: 0, stdout: '', stderr: '' })),
}));
vi.mock('../log/process-file.js', () => ({
  startProcessLog: mocks.startProcessLog,
  stopProcessLog: mocks.stopProcessLog,
}));
vi.mock('./build.js', () => ({ runServiceBuild: mocks.runServiceBuild }));
vi.mock('./startup-env.js', () => ({ assertStartupEnv: vi.fn() }));
vi.mock('../auto_fix/concordia-dispatch.js', () => ({ maybeDispatchCrashFixToConcordia: vi.fn() }));
vi.mock('./hot-reload.js', () => ({ assertHotReloadAllowed: vi.fn(async () => undefined) }));
vi.mock('./cernere-launch-credential.js', () => ({
  prepareSpawnEnv: mocks.prepareSpawnEnv,
}));
vi.mock('./identity.js', () => ({ verifyProcessIdentity: mocks.verifyProcessIdentity }));

import {
  adoptProcess,
  getManagedPid,
  isManaged,
  killService,
  resumeProcessRestarts,
  spawnService,
  validateManagedProcess,
} from './manager.js';

describe('process manager lifecycle hardening', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dbRun.mockReset();
    mocks.verifyProcessIdentity.mockResolvedValue(true);
    mocks.prepareSpawnEnv.mockImplementation(async (_svc: unknown, env: Record<string, string>) => env);
    resumeProcessRestarts();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects an asynchronous spawn error and cleans process/log state', async () => {
    const child = fakeChild(9101);
    mocks.spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit('error', new Error('ENOENT')));
      return child;
    });

    await expect(spawnService(service('spawn-error'))).rejects.toThrow('ENOENT');

    expect(isManaged('spawn-error')).toBe(false);
    expect(mocks.stopProcessLog).toHaveBeenCalledWith('spawn-error');
    expect(mocks.dbRun.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps a real spawned process successful when only running-state promotion fails', async () => {
    const child = fakeChild(9103);
    mocks.spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });
    let dbCalls = 0;
    mocks.dbRun.mockImplementation(() => {
      dbCalls += 1;
      if (dbCalls === 6) throw new Error('running state write failed');
    });

    await expect(spawnService(service('running-state-failure'))).resolves.toMatchObject({ child });
    expect(isManaged('running-state-failure')).toBe(true);

    const stopping = killService('running-state-failure');
    child.emit('exit', null, 'SIGTERM');
    await expect(stopping).resolves.toBe(true);
  });

  it('suppresses restart policy for an explicit stop and waits for exit handling', async () => {
    vi.useFakeTimers();
    const child = fakeChild(9102);
    mocks.spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });

    await spawnService(service('manual-stop'), { restartPolicy: 'always' });
    const stopping = killService('manual-stop');
    child.emit('exit', null, 'SIGTERM');
    await expect(stopping).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(isManaged('manual-stop')).toBe(false);
    expect(mocks.runServiceBuild).not.toHaveBeenCalled();
  });

  it('prunes a stale adopted PID identity and records a crash', async () => {
    const startedAt = new Date('2026-07-12T00:00:00.000Z');
    adoptProcess('stale-adopted', { pid: 9191, startedAt, verified: true });
    mocks.verifyProcessIdentity.mockResolvedValueOnce(false);

    await expect(validateManagedProcess('stale-adopted')).resolves.toBe(false);

    expect(isManaged('stale-adopted')).toBe(false);
    expect(mocks.verifyProcessIdentity).toHaveBeenCalledWith(9191, startedAt);
    expect(mocks.dbRun).toHaveBeenCalledTimes(2);
  });

  it('does not delete an adopted identity replaced during asynchronous validation', async () => {
    let resolveVerification = (_verified: boolean): void => undefined;
    mocks.verifyProcessIdentity.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
      resolveVerification = resolve;
    }));
    adoptProcess('replaced-adopted', {
      pid: 9192,
      startedAt: new Date('2026-07-12T00:00:00.000Z'),
      verified: true,
    });

    const validating = validateManagedProcess('replaced-adopted');
    adoptProcess('replaced-adopted', {
      pid: 9193,
      startedAt: new Date('2026-07-12T00:01:00.000Z'),
      verified: true,
    });
    resolveVerification(false);

    await expect(validating).resolves.toBe(true);
    expect(getManagedPid('replaced-adopted')).toBe(9193);
    await expect(killService('replaced-adopted')).resolves.toBe(true);
  });

  it('prunes a spawned child that has already exited', async () => {
    const child = fakeChild(9194);
    mocks.spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });
    await spawnService(service('already-exited'));
    child.exitCode = 3;

    await expect(validateManagedProcess('already-exited')).resolves.toBe(false);

    expect(isManaged('already-exited')).toBe(false);
  });

  it('cancels a pending crash restart when an explicit stop arrives during backoff', async () => {
    vi.useFakeTimers();
    const child = fakeChild(9195);
    mocks.spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });
    await spawnService(service('backoff-stop'), { restartPolicy: 'always' });
    child.exitCode = 1;
    child.emit('exit', 1, null);
    for (let index = 0; index < 4; index += 1) await Promise.resolve();

    await expect(killService('backoff-stop')).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it('reserves a service before asynchronous preparation so concurrent starts cannot overwrite it', async () => {
    const child = fakeChild(9196);
    mocks.spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });

    const first = spawnService(service('concurrent-start'), { restartPolicy: 'no' });
    const second = spawnService(service('concurrent-start'), { restartPolicy: 'no' });

    await expect(second).rejects.toThrow('already managed or being started');
    await expect(first).resolves.toMatchObject({ child });
    const stopping = killService('concurrent-start');
    child.emit('exit', null, 'SIGTERM');
    await expect(stopping).resolves.toBe(true);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(mocks.spawn).toHaveBeenCalledWith(
      'node',
      ['demo.js'],
      expect.objectContaining({ detached: true, windowsHide: true }),
    );
  });

  it('cancels a reserved start while credential preparation is in flight', async () => {
    let resolveCredential = (_env: Record<string, string>): void => undefined;
    mocks.prepareSpawnEnv.mockImplementationOnce(() => new Promise<Record<string, string>>((resolve) => {
      resolveCredential = resolve;
    }));

    const starting = spawnService(service('credential-stop'), { restartPolicy: 'no' });
    await vi.waitFor(() => expect(mocks.prepareSpawnEnv).toHaveBeenCalled());
    const stopping = killService('credential-stop');
    resolveCredential({});

    await expect(starting).rejects.toThrow('canceled by a newer lifecycle request');
    await expect(stopping).resolves.toBe(true);
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(isManaged('credential-stop')).toBe(false);
  });

  it('terminates a child whose spawn completes after an explicit stop', async () => {
    const child = fakeChild(9197);
    child.kill.mockImplementation((signal: NodeJS.Signals = 'SIGTERM') => {
      queueMicrotask(() => {
        child.signalCode = signal;
        child.emit('exit', null, signal);
      });
      return true;
    });
    mocks.spawn.mockReturnValue(child);

    const starting = spawnService(service('spawn-complete-stop'), { restartPolicy: 'no' });
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
    const stopping = killService('spawn-complete-stop');
    child.emit('spawn');

    await expect(starting).rejects.toThrow('canceled by a newer lifecycle request');
    await expect(stopping).resolves.toBe(true);
    expect(isManaged('spawn-complete-stop')).toBe(false);
    expect(mocks.stopProcessLog).toHaveBeenCalledWith('spawn-complete-stop');
  });
});

function fakeChild(pid: number): EventEmitter & {
  pid: number;
  unref: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
} {
  return Object.assign(new EventEmitter(), {
    pid,
    unref: vi.fn(),
    kill: vi.fn(() => true),
    exitCode: null,
    signalCode: null,
  });
}

function service(code: string): Service {
  return {
    code,
    name: code,
    runtime: 'node',
    cwd: process.cwd(),
    command: 'node demo.js',
    disabled: false,
    develop_derived: false,
    monitor_only: false,
    depends_on: [],
    autostart: false,
    allow_hot_reload: false,
    restart_policy: 'always',
    max_restart: 5,
    required_env: [],
  } as Service;
}
