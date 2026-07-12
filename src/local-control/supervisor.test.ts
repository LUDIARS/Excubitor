import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExcubitorBackendController } from './excubitor-backend.js';
import {
  LOCAL_CONTROL_PROTOCOL_VERSION,
  type ExcubitorStatusPayload,
  type LocalControlRequest,
} from './protocol.js';
import { LocalControlStateStore } from './state-store.js';
import { LocalControlSupervisor } from './supervisor.js';
import type { LocalControlDispatch } from './server.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('LocalControlSupervisor deferred operations', () => {
  it('executes a concurrently committed deferred operation id exactly once', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'excubitor-supervisor-test-'));
    temporaryDirectories.push(rootDir);
    const running = status('running');
    const restart = vi.fn(async () => running);
    const backend = {
      restart,
      start: vi.fn(async () => running),
      stop: vi.fn(async () => status('stopped')),
      status: vi.fn(() => running),
    } as unknown as ExcubitorBackendController;
    const supervisor = new LocalControlSupervisor({
      rootDir,
      statePath: join(rootDir, 'state.json'),
      backend,
    });
    const internals = supervisor as unknown as {
      stateStore: LocalControlStateStore;
      resolveReady: () => void;
      dispatch: (request: LocalControlRequest) => Promise<LocalControlDispatch>;
    };
    await internals.stateStore.initialize({ pid: process.pid, startedAt: '2026-07-12T00:00:00.000Z' });
    internals.resolveReady();

    const request: LocalControlRequest = {
      protocol_version: LOCAL_CONTROL_PROTOCOL_VERSION,
      operation_id: 'same-restart-operation',
      target: { kind: 'excubitor' },
      action: 'restart',
      actor: 'test',
      dispatch: 'prepare',
    };
    const prepared = await internals.dispatch(request);
    expect(prepared.response.state).toBe('accepted');
    expect(prepared.afterReply).toBeUndefined();

    const commitRequest: LocalControlRequest = { ...request, dispatch: 'commit' };
    const [first, concurrentRetry] = await Promise.all([
      internals.dispatch(commitRequest),
      internals.dispatch(commitRequest),
    ]);

    await Promise.all([first.afterReply?.(), concurrentRetry.afterReply?.()]);
    expect(restart).toHaveBeenCalledTimes(1);

    const completedRetry = await internals.dispatch(commitRequest);
    expect(completedRetry.response.state).toBe('completed');
    expect(completedRetry.afterReply).toBeUndefined();
  });

  it('waits for an execute restart to complete', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'excubitor-supervisor-test-'));
    temporaryDirectories.push(rootDir);
    const running = status('running');
    const restart = vi.fn(async () => running);
    const supervisor = new LocalControlSupervisor({
      rootDir,
      statePath: join(rootDir, 'state.json'),
      backend: { restart } as unknown as ExcubitorBackendController,
    });
    const internals = supervisor as unknown as {
      stateStore: LocalControlStateStore;
      resolveReady: () => void;
      dispatch: (request: LocalControlRequest) => Promise<LocalControlDispatch>;
    };
    await internals.stateStore.initialize({ pid: process.pid, startedAt: '2026-07-12T00:00:00.000Z' });
    internals.resolveReady();

    const dispatch = await internals.dispatch({
      protocol_version: LOCAL_CONTROL_PROTOCOL_VERSION,
      operation_id: 'execute-restart-operation',
      target: { kind: 'excubitor' },
      action: 'restart',
      actor: 'test',
      dispatch: 'execute',
    });

    expect(dispatch.response.state).toBe('completed');
    expect(dispatch.afterReply).toBeUndefined();
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('serves status without writing operation history', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'excubitor-supervisor-status-test-'));
    temporaryDirectories.push(rootDir);
    const running = status('running');
    const supervisor = new LocalControlSupervisor({
      rootDir,
      statePath: join(rootDir, 'state.json'),
      backend: { status: vi.fn(() => running) } as unknown as ExcubitorBackendController,
    });
    const internals = supervisor as unknown as {
      stateStore: LocalControlStateStore;
      resolveReady: () => void;
      dispatch: (request: LocalControlRequest) => Promise<LocalControlDispatch>;
    };
    const accepted = vi.spyOn(internals.stateStore, 'recordAccepted');
    const completed = vi.spyOn(internals.stateStore, 'recordCompleted');
    internals.resolveReady();

    const result = await internals.dispatch({
      protocol_version: LOCAL_CONTROL_PROTOCOL_VERSION,
      operation_id: 'status-read-only',
      target: { kind: 'excubitor' },
      action: 'status',
      actor: 'test',
      dispatch: 'execute',
    });

    expect(result.response).toMatchObject({ ok: true, state: 'completed', payload: running });
    expect(accepted).not.toHaveBeenCalled();
    expect(completed).not.toHaveBeenCalled();
  });

  it('returns the actual lifecycle result when completion persistence fails', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'excubitor-supervisor-persist-test-'));
    temporaryDirectories.push(rootDir);
    const running = status('running');
    const supervisor = new LocalControlSupervisor({
      rootDir,
      statePath: join(rootDir, 'state.json'),
      backend: { start: vi.fn(async () => running) } as unknown as ExcubitorBackendController,
    });
    const internals = supervisor as unknown as {
      stateStore: LocalControlStateStore;
      resolveReady: () => void;
      dispatch: (request: LocalControlRequest) => Promise<LocalControlDispatch>;
    };
    await internals.stateStore.initialize({ pid: process.pid, startedAt: '2026-07-12T00:00:00.000Z' });
    vi.spyOn(internals.stateStore, 'recordCompleted').mockRejectedValue(new Error('disk full'));
    internals.resolveReady();

    const result = await internals.dispatch({
      protocol_version: LOCAL_CONTROL_PROTOCOL_VERSION,
      operation_id: 'persist-failure-start',
      target: { kind: 'excubitor' },
      action: 'start',
      actor: 'test',
      dispatch: 'execute',
    });

    expect(result.response).toMatchObject({ ok: true, state: 'completed', payload: running });
  });

  it('returns Excubitor status while a restart occupies the target queue', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'excubitor-supervisor-status-during-restart-'));
    temporaryDirectories.push(rootDir);
    let releaseRestart = (): void => undefined;
    let markRestartStarted = (): void => undefined;
    const restartStarted = new Promise<void>((resolve) => { markRestartStarted = resolve; });
    const restarting = status('starting');
    const running = status('running');
    const backend = {
      status: vi.fn(() => restarting),
      restart: vi.fn(() => new Promise<ExcubitorStatusPayload>((resolve) => {
        releaseRestart = () => resolve(running);
        markRestartStarted();
      })),
    } as unknown as ExcubitorBackendController;
    const supervisor = new LocalControlSupervisor({
      rootDir,
      statePath: join(rootDir, 'state.json'),
      backend,
    });
    const internals = supervisor as unknown as {
      stateStore: LocalControlStateStore;
      resolveReady: () => void;
      dispatch: (request: LocalControlRequest) => Promise<LocalControlDispatch>;
    };
    await internals.stateStore.initialize({ pid: process.pid, startedAt: '2026-07-12T00:00:00.000Z' });
    internals.resolveReady();
    const restart = internals.dispatch({
      protocol_version: LOCAL_CONTROL_PROTOCOL_VERSION,
      operation_id: 'blocking-restart',
      target: { kind: 'excubitor' },
      action: 'restart',
      actor: 'test',
      dispatch: 'execute',
    });
    await restartStarted;

    const snapshot = await internals.dispatch({
      protocol_version: LOCAL_CONTROL_PROTOCOL_VERSION,
      operation_id: 'status-during-restart',
      target: { kind: 'excubitor' },
      action: 'status',
      actor: 'test',
      dispatch: 'execute',
    });
    expect(snapshot.response).toMatchObject({ ok: true, payload: restarting });
    releaseRestart();
    await restart;
  });

  it('rejects reuse of an operation id with a different dispatch phase', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'excubitor-supervisor-phase-conflict-'));
    temporaryDirectories.push(rootDir);
    const supervisor = new LocalControlSupervisor({ rootDir, statePath: join(rootDir, 'state.json') });
    const internals = supervisor as unknown as {
      stateStore: LocalControlStateStore;
      resolveReady: () => void;
      dispatch: (request: LocalControlRequest) => Promise<LocalControlDispatch>;
    };
    await internals.stateStore.initialize({ pid: process.pid, startedAt: '2026-07-12T00:00:00.000Z' });
    internals.resolveReady();
    const prepared: LocalControlRequest = {
      protocol_version: LOCAL_CONTROL_PROTOCOL_VERSION,
      operation_id: 'phase-conflict',
      target: { kind: 'excubitor' },
      action: 'restart',
      actor: 'test',
      dispatch: 'prepare',
    };
    await internals.dispatch(prepared);

    const conflict = await internals.dispatch({ ...prepared, dispatch: 'execute' });

    expect(conflict.response).toMatchObject({ ok: false, error: { code: 'OPERATION_ID_CONFLICT' } });
  });

  it('does not run a deferred restart after supervisor close begins', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'excubitor-supervisor-deferred-close-'));
    temporaryDirectories.push(rootDir);
    const running = status('running');
    const restart = vi.fn(async () => running);
    const supervisor = new LocalControlSupervisor({
      rootDir,
      statePath: join(rootDir, 'state.json'),
      backend: { restart } as unknown as ExcubitorBackendController,
    });
    const internals = supervisor as unknown as {
      stateStore: LocalControlStateStore;
      resolveReady: () => void;
      dispatch: (request: LocalControlRequest) => Promise<LocalControlDispatch>;
    };
    await internals.stateStore.initialize({ pid: process.pid, startedAt: '2026-07-12T00:00:00.000Z' });
    internals.resolveReady();
    const request: LocalControlRequest = {
      protocol_version: LOCAL_CONTROL_PROTOCOL_VERSION,
      operation_id: 'deferred-close',
      target: { kind: 'excubitor' },
      action: 'restart',
      actor: 'test',
      dispatch: 'prepare',
    };
    await internals.dispatch(request);
    const committed = await internals.dispatch({ ...request, dispatch: 'commit' });

    await supervisor.close();
    await committed.afterReply?.();

    expect(restart).not.toHaveBeenCalled();
  });

  it('does not continue startup after close is requested while IPC is opening', async () => {
    const running = status('running');
    const recover = vi.fn(async () => running);
    const preserve = vi.fn(async () => undefined);
    const supervisor = new LocalControlSupervisor({
      backend: { recover, preserveForSupervisorShutdown: preserve, status: vi.fn(() => running) } as unknown as ExcubitorBackendController,
    });
    let resolveListen = (): void => undefined;
    const listen = vi.fn(() => new Promise<void>((resolve) => { resolveListen = resolve; }));
    const serverClose = vi.fn(async () => undefined);
    const reaperStart = vi.fn();
    const reaperClose = vi.fn(async () => undefined);
    const catalogInitialize = vi.fn(async () => undefined);
    const recordExcubitor = vi.fn(async () => undefined);
    const internals = supervisor as unknown as {
      server: { listen: typeof listen; close: typeof serverClose };
      adoptedProcessReaper: { start: typeof reaperStart; close: typeof reaperClose };
      catalog: { initialize: typeof catalogInitialize };
      stateStore: { recordExcubitor: typeof recordExcubitor };
    };
    internals.server = { listen, close: serverClose };
    internals.adoptedProcessReaper = { start: reaperStart, close: reaperClose };
    internals.catalog = { initialize: catalogInitialize };
    internals.stateStore = { recordExcubitor };

    const starting = supervisor.start();
    await Promise.resolve();
    expect(listen).toHaveBeenCalled();
    const closing = supervisor.close();
    resolveListen();
    await starting;
    await closing;

    expect(recover).not.toHaveBeenCalled();
    expect(catalogInitialize).not.toHaveBeenCalled();
    expect(reaperStart).not.toHaveBeenCalled();
    expect(serverClose).toHaveBeenCalled();
    expect(preserve).toHaveBeenCalled();
  });

  it('does not release backend or DB ownership when endpoint close fails', async () => {
    const stopped = status('stopped');
    const backendPreserve = vi.fn(async () => undefined);
    const recordExcubitor = vi.fn(async () => undefined);
    const serverClose = vi.fn(async () => { throw new Error('server close failed'); });
    const reaperClose = vi.fn(async () => { throw new Error('reaper close failed'); });
    const supervisor = new LocalControlSupervisor({
      backend: { preserveForSupervisorShutdown: backendPreserve, status: vi.fn(() => stopped) } as unknown as ExcubitorBackendController,
    });
    const internals = supervisor as unknown as {
      started: boolean;
      server: { close: typeof serverClose };
      adoptedProcessReaper: { close: typeof reaperClose };
      stateStore: { recordExcubitor: typeof recordExcubitor };
    };
    internals.started = true;
    internals.server = { close: serverClose };
    internals.adoptedProcessReaper = { close: reaperClose };
    internals.stateStore = { recordExcubitor };

    await expect(supervisor.close()).rejects.toBeInstanceOf(AggregateError);

    expect(serverClose).toHaveBeenCalled();
    expect(reaperClose).toHaveBeenCalled();
    expect(backendPreserve).not.toHaveBeenCalled();
    expect(recordExcubitor).not.toHaveBeenCalled();
  });

  it('keeps the endpoint owned when accepted operations miss the drain deadline', async () => {
    const running = status('running');
    let release = (): void => undefined;
    let markStarted = (): void => undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const backendPreserve = vi.fn(async () => undefined);
    const serverClose = vi.fn(async () => undefined);
    const supervisor = new LocalControlSupervisor({
      backend: {
        preserveForSupervisorShutdown: backendPreserve,
        status: vi.fn(() => running),
      } as unknown as ExcubitorBackendController,
      operationDrainTimeoutMs: 10,
    });
    const internals = supervisor as unknown as {
      started: boolean;
      operations: { run: <T>(key: string, operation: () => Promise<T>) => Promise<T> };
      server: { close: typeof serverClose };
      adoptedProcessReaper: { close: () => Promise<void> };
      stateStore: { recordExcubitor: () => Promise<void> };
    };
    internals.started = true;
    internals.server = { close: serverClose };
    internals.adoptedProcessReaper = { close: async () => undefined };
    internals.stateStore = { recordExcubitor: async () => undefined };
    const active = internals.operations.run('service:held', () => new Promise<void>((resolve) => {
      release = resolve;
      markStarted();
    }));
    await started;

    await expect(supervisor.close()).rejects.toBeInstanceOf(AggregateError);

    expect(serverClose).not.toHaveBeenCalled();
    expect(backendPreserve).not.toHaveBeenCalled();
    release();
    await active;
  });

  it('waits for an active target operation before preserving the backend', async () => {
    const stopped = status('stopped');
    const events: string[] = [];
    let release = (): void => undefined;
    let markStarted = (): void => undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const backendPreserve = vi.fn(async () => { events.push('backend'); });
    const supervisor = new LocalControlSupervisor({
      backend: { preserveForSupervisorShutdown: backendPreserve, status: vi.fn(() => stopped) } as unknown as ExcubitorBackendController,
      operationDrainTimeoutMs: 1_000,
    });
    const internals = supervisor as unknown as {
      started: boolean;
      operations: { run: <T>(key: string, operation: () => Promise<T>) => Promise<T> };
      server: { close: () => Promise<void> };
      adoptedProcessReaper: { close: () => Promise<void> };
      stateStore: { recordExcubitor: () => Promise<void> };
    };
    internals.started = true;
    internals.server = { close: async () => { events.push('server'); } };
    internals.adoptedProcessReaper = { close: async () => { events.push('reaper'); } };
    internals.stateStore = { recordExcubitor: async () => { events.push('state'); } };
    const active = internals.operations.run('service:alpha', () => new Promise<void>((resolve) => {
      release = () => {
        events.push('operation');
        resolve();
      };
      markStarted();
    }));
    await started;

    const closing = supervisor.close();
    await Promise.resolve();
    expect(backendPreserve).not.toHaveBeenCalled();
    release();
    await active;
    await closing;

    expect(events.indexOf('operation')).toBeLessThan(events.indexOf('backend'));
  });
});

function status(state: ExcubitorStatusPayload['state']): ExcubitorStatusPayload {
  return {
    kind: 'excubitor-status',
    state,
    desired_state: state === 'stopped' ? 'stopped' : 'running',
    pid: state === 'stopped' ? null : 5678,
    restart_count: 0,
    last_exit_code: null,
    last_signal: null,
    last_error: null,
    instance_token: state === 'stopped' ? null : 'test-token',
  };
}
