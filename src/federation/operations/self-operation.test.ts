import { describe, expect, it, vi } from 'vitest';
import type { Service } from '../../catalog/loader.js';
import type { StepResult } from '../../update/steps.js';
import type { OperationContext } from './context.js';
import type { OperationRecord } from './store.js';
import { runSelfOperation, selfRepoOf, type SelfOperationDeps } from './self-operation.js';
import type { OperationAction } from './types.js';

const self = { dir: 'C:/Ars/Excubitor', repo: 'LUDIARS/Excubitor' };

function ctx(action: OperationAction): OperationContext & { steps: StepResult[] } {
  const steps: StepResult[] = [];
  return {
    op: { id: 'op-self', action, source: 'origin', target: { kind: 'excubitor' } } as OperationRecord,
    actor: 'federation:mac',
    requester: null,
    record: (step) => steps.push(step),
    steps,
  };
}

function deps(overrides: Partial<SelfOperationDeps> = {}) {
  return {
    fetch: vi.fn(async () => [{ step: 'pull', ok: true, detail: '' }]),
    install: vi.fn(async (_dir: string, opts?: { prefix?: string }) => ({ step: opts?.prefix ? `install:${opts.prefix}` : 'install', ok: true, detail: '' })),
    npmBuild: vi.fn(async (_dir: string, prefix?: string) => ({ step: prefix ? `build:${prefix}` : 'build', ok: true, detail: '' })),
    readHead: vi.fn(async () => ({ branch: 'main', hash: 'newhash' })),
    isDirty: vi.fn(async () => false),
    bootHash: vi.fn(() => 'oldhash'),
    requestRestart: vi.fn(async () => ({ ok: true, error: null })),
    markRestarting: vi.fn(),
    hasFrontend: vi.fn(() => true),
    ...overrides,
  };
}

describe('runSelfOperation', () => {
  it('deploy pulls, installs and builds backend + frontend, then hands off to the supervisor', async () => {
    const d = deps();
    const c = ctx('deploy');
    await expect(runSelfOperation(self, c, d)).resolves.toEqual({ kind: 'restarting' });
    expect(c.steps.map((s) => s.step)).toEqual(['pull', 'install', 'install:frontend', 'build', 'build:frontend', 'restart_requested']);
    expect(d.markRestarting).toHaveBeenCalledWith('op-self', { expected_hash: 'newhash' });
    expect(d.requestRestart).toHaveBeenCalledWith('federation:mac');
  });

  it('update only pulls and never restarts', async () => {
    const d = deps();
    await expect(runSelfOperation(self, ctx('update'), d)).resolves.toMatchObject({ kind: 'finished', ok: true });
    expect(d.requestRestart).not.toHaveBeenCalled();
    expect(d.npmBuild).not.toHaveBeenCalled();
  });

  it('refuses to pull into a dirty Excubitor checkout', async () => {
    const d = deps({ isDirty: vi.fn(async () => true) });
    await expect(runSelfOperation(self, ctx('deploy'), d)).resolves.toMatchObject({ ok: false });
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it('reflect does nothing when the running version is already the disk version', async () => {
    const d = deps({ bootHash: vi.fn(() => 'newhash') });
    const c = ctx('reflect');
    await expect(runSelfOperation(self, c, d)).resolves.toMatchObject({ ok: true });
    expect(d.npmBuild).not.toHaveBeenCalled();
    expect(d.requestRestart).not.toHaveBeenCalled();
  });

  it('reflect builds and restarts when disk moved ahead of the running process', async () => {
    const d = deps();
    await expect(runSelfOperation(self, ctx('reflect'), d)).resolves.toEqual({ kind: 'restarting' });
    expect(d.fetch).not.toHaveBeenCalled();
    expect(d.npmBuild).toHaveBeenCalledTimes(2);
  });

  it('reports a rejected restart as a failure', async () => {
    const d = deps({ requestRestart: vi.fn(async () => ({ ok: false, error: 'supervisor unavailable' })) });
    await expect(runSelfOperation(self, ctx('restart'), d))
      .resolves.toEqual({ kind: 'finished', ok: false, error: 'restart_requested: supervisor unavailable' });
  });

  it('does not accept stop on itself', async () => {
    await expect(runSelfOperation(self, ctx('stop'), deps())).resolves.toMatchObject({ ok: false });
  });
});

describe('selfRepoOf', () => {
  it('uses the excubitor catalog entry and falls back to the process cwd', () => {
    const entry = { code: 'excubitor', cwd: 'E:/Ars/Excubitor', repo: 'LUDIARS/Excubitor' } as Service;
    expect(selfRepoOf({ services: [entry] }, 'X:/cwd')).toEqual({ dir: 'E:/Ars/Excubitor', repo: 'LUDIARS/Excubitor' });
    expect(selfRepoOf({ services: [] }, 'X:/cwd')).toEqual({ dir: 'X:/cwd', repo: null });
  });
});
