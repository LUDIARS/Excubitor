import { describe, expect, it, vi } from 'vitest';
import type { Catalog, Service } from '../../catalog/loader.js';
import { DailyRepositoryTransaction, type DailyTransactionDeps } from './transaction.js';
import type { DailyRun } from './types.js';

function fixture() {
  const services = ['running', 'stopped'].map((code) => ({ code, runtime: 'node', cwd: '/repo' } as Service));
  const run: DailyRun = { id: 'run', day: '2026-10-06', startedAt: '2026-10-05T21:00:00Z', finishedAt: null,
    status: 'running', checkpoint: null, events: [], notification: null };
  const snapshots: DailyRun[] = [];
  const deps = {
    runtime: { catalog: vi.fn(async () => ({ services } as Catalog)), running: vi.fn(async (svc: Service) => svc.code === 'running'),
      start: vi.fn(async (_svc: Service) => undefined), stop: vi.fn(async (_svc: Service) => undefined), healthy: vi.fn(async () => true) },
    build: vi.fn(async () => undefined), command: vi.fn(async () => ''),
    prepare: vi.fn(async () => ({ branch: 'main', before: 'old', after: 'new' })),
    assertExpected: vi.fn(async () => undefined), save: vi.fn((value: DailyRun) => { snapshots.push(structuredClone(value)); }),
    waitHealthy: vi.fn(async () => undefined),
  } satisfies DailyTransactionDeps;
  return { services, run, deps, snapshots, transaction: new DailyRepositoryTransaction(deps) };
}
describe('repository deployment recovery', () => {
  it('does not rebuild or restart unchanged repositories', async () => {
    const f = fixture(); f.deps.prepare.mockResolvedValue({ branch: 'main', before: 'old', after: 'old' });
    await f.transaction.update({ path: '/repo', services: f.services }, f.run);
    expect(f.deps.build).not.toHaveBeenCalled(); expect(f.deps.runtime.stop).not.toHaveBeenCalled();
  });
  it('persists old definitions before stopping and only restores previously running services', async () => {
    const f = fixture();
    f.deps.runtime.stop.mockImplementation(async () => { expect(f.snapshots[0]?.checkpoint?.running).toEqual(['running']); });
    await f.transaction.update({ path: '/repo', services: f.services }, f.run);
    expect(f.deps.runtime.start.mock.calls.map(([svc]) => svc.code)).toEqual(['running']);
    expect(f.deps.build).toHaveBeenCalledTimes(1);
    expect(f.run.checkpoint).toBeNull();
  });
  it('restores old commit, dependencies and service after new startup fails', async () => {
    const f = fixture(); f.deps.waitHealthy.mockRejectedValueOnce(new Error('startup failed'));
    await f.transaction.update({ path: '/repo', services: f.services }, f.run);
    expect(f.deps.command).toHaveBeenCalledWith('git', ['reset', '--keep', 'old'], '/repo');
    expect(f.deps.build).toHaveBeenCalledTimes(2);
    expect(f.deps.runtime.start.mock.calls.map(([svc]) => svc.code)).toEqual(['running', 'running']);
    expect(f.run.events.map((event) => event.status)).toEqual(['update-failed', 'rolled-back']);
    expect(f.run.checkpoint).toBeNull();
  });
  it('retains durable recovery evidence when even old startup fails', async () => {
    const f = fixture(); f.deps.waitHealthy.mockRejectedValue(new Error('both versions fail'));
    await expect(f.transaction.update({ path: '/repo', services: f.services }, f.run)).rejects.toThrow('both versions fail');
    expect(f.run.checkpoint?.phase).toBe('rollback');
    expect(f.run.checkpoint?.before).toBe('old');
  });
  it('does not discard edits made while a build was running', async () => {
    const f = fixture(); f.deps.build.mockRejectedValueOnce(new Error('failed'));
    f.deps.assertExpected.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('external edit'));
    await expect(f.transaction.update({ path: '/repo', services: f.services }, f.run)).rejects.toThrow('external edit');
    expect(f.deps.command.mock.calls.some((call) => (call as unknown[])[1]?.toString().includes('reset'))).toBe(false);
  });
  it('recovers a journal left between stop and merge without reissuing a pull', async () => {
    const f = fixture();
    f.run.checkpoint = { path: '/repo', branch: 'main', before: 'old', after: 'new', services: f.services, running: ['running'], phase: 'stopping' };
    await f.transaction.rollback(f.run);
    expect(f.deps.prepare).not.toHaveBeenCalled();
    expect(f.deps.runtime.start.mock.calls.map(([svc]) => svc.code)).toEqual(['running']);
    expect(f.run.checkpoint).toBeNull();
  });
});
