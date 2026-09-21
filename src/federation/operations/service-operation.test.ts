import { describe, expect, it, vi } from 'vitest';
import type { Service } from '../../catalog/loader.js';
import type { StepResult } from '../../update/steps.js';
import type { OperationContext } from './context.js';
import type { OperationRecord } from './store.js';
import { reflectNeedsRestart, runServiceOperation, type ServiceOperationDeps } from './service-operation.js';
import type { OperationAction, UpdateSource } from './types.js';

const svc = { code: 'svc-a', name: 'A', repo: 'LUDIARS/A', cwd: 'C:/repos/a' } as Service;

function ctx(action: OperationAction, source: UpdateSource = 'origin'): OperationContext & { steps: StepResult[] } {
  const steps: StepResult[] = [];
  return {
    op: { id: 'op-1', action, source, target: { kind: 'service', code: 'svc-a' } } as OperationRecord,
    actor: 'federation:mac',
    requester: null,
    record: (step) => steps.push(step),
    steps,
  };
}

function deps(overrides: Partial<ServiceOperationDeps> = {}): Required<ServiceOperationDeps> {
  return {
    control: vi.fn(async (_svc, action) => ({ step: action, ok: true, detail: '' })),
    checkRepo: vi.fn(async () => ({ ready: { repoDir: 'C:/repos/a', branch: 'main' }, step: null })),
    fetch: vi.fn(async () => [{ step: 'pull', ok: true, detail: 'Fast-forward' }]),
    install: vi.fn(async () => ({ step: 'install', ok: true, detail: '' })),
    build: vi.fn(async () => ({ step: 'build', ok: true, detail: '' })),
    isRunning: vi.fn(() => true),
    versionStatus: vi.fn(async () => 'mismatch' as const),
    ...overrides,
  } as Required<ServiceOperationDeps>;
}

describe('runServiceOperation', () => {
  it('update only fetches (no install, build or restart)', async () => {
    const d = deps();
    const c = ctx('update');
    await expect(runServiceOperation(svc, c, d)).resolves.toEqual({ kind: 'finished', ok: true, error: null });
    expect(d.fetch).toHaveBeenCalledWith(expect.objectContaining({ source: 'origin', repoDir: 'C:/repos/a', branch: 'main', repo: 'LUDIARS/A' }));
    expect(d.install).not.toHaveBeenCalled();
    expect(d.control).not.toHaveBeenCalled();
    expect(c.steps.map((s) => s.step)).toEqual(['pull']);
  });

  it('deploy fetches, installs, builds, then restarts a running service', async () => {
    const d = deps();
    const c = ctx('deploy', 'mesh');
    await expect(runServiceOperation(svc, c, d)).resolves.toMatchObject({ ok: true });
    expect(c.steps.map((s) => s.step)).toEqual(['pull', 'install', 'build', 'restart']);
    expect(d.install).toHaveBeenCalledWith('C:/repos/a', { preferOffline: true });
    expect(d.build).toHaveBeenCalledWith(svc, 'C:/repos/a', 'auto');
  });

  it('deploy does not start a service that was not running', async () => {
    const d = deps({ isRunning: vi.fn(() => false) });
    const c = ctx('deploy');
    await runServiceOperation(svc, c, d);
    expect(d.control).not.toHaveBeenCalled();
    expect(c.steps.at(-1)).toMatchObject({ step: 'restart', ok: true });
  });

  it('stops at the first failing step and reports it', async () => {
    const d = deps({ install: vi.fn(async () => ({ step: 'install', ok: false, detail: 'ENOTFOUND registry' })) });
    const c = ctx('deploy');
    await expect(runServiceOperation(svc, c, d)).resolves.toEqual({ kind: 'finished', ok: false, error: 'install: ENOTFOUND registry' });
    expect(d.build).not.toHaveBeenCalled();
    expect(d.control).not.toHaveBeenCalled();
  });

  it('refuses to fetch into a dirty checkout', async () => {
    const d = deps({ checkRepo: vi.fn(async () => ({ ready: null, step: { step: 'dirty_check', ok: false, detail: 'dirty' } })) });
    await expect(runServiceOperation(svc, ctx('update'), d)).resolves.toMatchObject({ ok: false, error: 'dirty_check: dirty' });
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it('reflect builds and restarts only when the running version differs from disk', async () => {
    const mismatch = deps();
    await runServiceOperation(svc, ctx('reflect'), mismatch);
    expect(mismatch.fetch).not.toHaveBeenCalled();
    expect(mismatch.control).toHaveBeenCalledWith(svc, 'restart', 'federation:mac');

    const match = deps({ versionStatus: vi.fn(async () => 'match' as const) });
    const c = ctx('reflect');
    await runServiceOperation(svc, c, match);
    expect(match.control).not.toHaveBeenCalled();
    expect(c.steps.at(-1)!.detail).toMatch(/一致/);
  });

  it('start / stop / restart go straight to the supervisor', async () => {
    const d = deps();
    await runServiceOperation(svc, ctx('stop'), d);
    expect(d.control).toHaveBeenCalledWith(svc, 'stop', 'federation:mac');
    expect(d.checkRepo).not.toHaveBeenCalled();
  });
});

describe('reflectNeedsRestart', () => {
  it('restarts on mismatch and when the version cannot be confirmed', () => {
    expect(reflectNeedsRestart('match')).toBe(false);
    expect(reflectNeedsRestart('mismatch')).toBe(true);
    expect(reflectNeedsRestart('unknown')).toBe(true);
  });
});
