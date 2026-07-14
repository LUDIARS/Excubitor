import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Service } from '../catalog/loader.js';
import { AdoptedProcessReaper } from './adopted-process-reaper.js';
import { TargetOperationQueue } from './target-queue.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('AdoptedProcessReaper', () => {
  it('retries a vanished adopted process only up to the catalog limit', async () => {
    const adopted = new Set(['alpha']);
    const control = vi.fn(async () => failedControl());
    const reaper = new AdoptedProcessReaper({
      queue: new TargetOperationQueue(),
      refreshCatalog: async () => undefined,
      service: () => service({ restart_policy: 'always', max_restart: 2 }),
      listAdopted: () => Array.from(adopted),
      isAdopted: (code) => adopted.has(code),
      shouldRecover: () => true,
      validateManaged: vi.fn(async () => {
        adopted.delete('alpha');
        return false;
      }),
      control,
    });

    await reaper.runOnce();
    await reaper.runOnce();
    await reaper.runOnce();

    expect(control).toHaveBeenCalledTimes(2);
  });

  it('does not restart disabled services or services with restart disabled', async () => {
    const control = vi.fn(async () => successfulControl());
    const services = new Map([
      ['disabled', service({ code: 'disabled', disabled: true, restart_policy: 'always' })],
      ['no-restart', service({ code: 'no-restart', restart_policy: 'no' })],
    ]);
    const reaper = new AdoptedProcessReaper({
      queue: new TargetOperationQueue(),
      refreshCatalog: async () => undefined,
      service: (code) => services.get(code),
      listAdopted: () => ['disabled', 'no-restart'],
      isAdopted: () => true,
      shouldRecover: () => true,
      validateManaged: vi.fn(async () => false),
      control,
    });

    await reaper.runOnce();

    expect(control).not.toHaveBeenCalled();
  });

  it('serializes recovery behind an existing operation for the same service', async () => {
    const queue = new TargetOperationQueue();
    let release = (): void => undefined;
    let markStarted = (): void => undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const blocker = queue.run('service:alpha', () => new Promise<void>((resolve) => {
      release = resolve;
      markStarted();
    }));
    await started;
    const control = vi.fn(async () => successfulControl());
    const reaper = new AdoptedProcessReaper({
      queue,
      refreshCatalog: async () => undefined,
      service: () => service(),
      listAdopted: () => ['alpha'],
      isAdopted: () => true,
      shouldRecover: () => true,
      validateManaged: vi.fn(async () => false),
      control,
    });

    const reap = reaper.runOnce();
    await Promise.resolve();
    expect(control).not.toHaveBeenCalled();
    release();
    await blocker;
    await reap;

    expect(control).toHaveBeenCalledTimes(1);
  });

  it('does not restart an adopted process explicitly removed while recovery was queued', async () => {
    const queue = new TargetOperationQueue();
    const adopted = new Set(['alpha']);
    let release = (): void => undefined;
    let markStarted = (): void => undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const blocker = queue.run('service:alpha', () => new Promise<void>((resolve) => {
      release = resolve;
      markStarted();
    }));
    await started;
    const validateManaged = vi.fn(async () => false);
    const control = vi.fn(async () => successfulControl());
    const reaper = new AdoptedProcessReaper({
      queue,
      refreshCatalog: async () => undefined,
      service: () => service(),
      listAdopted: () => Array.from(adopted),
      isAdopted: (code) => adopted.has(code),
      shouldRecover: () => true,
      validateManaged,
      control,
    });

    const reap = reaper.runOnce();
    adopted.delete('alpha');
    release();
    await blocker;
    await reap;

    expect(validateManaged).not.toHaveBeenCalled();
    expect(control).not.toHaveBeenCalled();
  });

  it('stops periodic checks and waits for the active tick on close', async () => {
    vi.useFakeTimers();
    const refreshCatalog = vi.fn(async () => undefined);
    const reaper = new AdoptedProcessReaper({
      queue: new TargetOperationQueue(),
      refreshCatalog,
      service: () => undefined,
      listAdopted: () => [],
      validateManaged: vi.fn(async () => false),
      intervalMs: 10,
    });
    reaper.start();
    await vi.advanceTimersByTimeAsync(10);
    await reaper.close();
    await vi.advanceTimersByTimeAsync(100);

    expect(refreshCatalog).toHaveBeenCalledTimes(1);
  });
});

function service(overrides: Partial<Service> = {}): Service {
  return {
    code: 'alpha',
    name: 'Alpha',
    runtime: 'node',
    disabled: false,
    monitor_only: false,
    depends_on: [],
    autostart: false,
    allow_hot_reload: false,
    restart_policy: 'always',
    max_restart: 5,
    required_env: [],
    ...overrides,
  } as Service;
}

function successfulControl() {
  return { ok: true, stdout: '', stderr: '', exit_code: 0, command: 'start' };
}

function failedControl() {
  return { ok: false, stdout: '', stderr: 'failed', exit_code: -1, command: 'start' };
}
