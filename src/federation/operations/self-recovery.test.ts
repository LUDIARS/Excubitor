import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Catalog } from '../../catalog/loader.js';
import type { OperationRecord } from './store.js';
import { recoverSelfService } from './self-recovery.js';

const mocks = vi.hoisted(() => ({
  control: vi.fn(), plan: vi.fn(), restart: vi.fn(), generation: vi.fn(), version: vi.fn(),
  step: vi.fn(), meta: vi.fn(), viewer: vi.fn(),
}));
vi.mock('../../local-control/client.js', () => ({ requestLocalControl: mocks.control }));
vi.mock('../../local-control/supervisor-service-restart.js', () => ({ planSupervisorRestart: mocks.plan, restartInstalledSupervisor: mocks.restart }));
vi.mock('../../local-control/supervisor-version.js', () => ({ readSupervisorGeneration: mocks.generation, readSupervisorVersion: mocks.version }));
vi.mock('./store.js', () => ({ appendStep: mocks.step, updateOperationMeta: mocks.meta }));
vi.mock('./self-viewer.js', () => ({ refreshSelfViewer: mocks.viewer }));

const old = { pid: 10, started_at: 'old' };
const next = { pid: 20, started_at: 'new' };
const catalog = { services: [{ code: 'excubitor', cwd: '/site/Excubitor' }, { code: 'excubitor-viewer-dmz' }] } as Catalog;
function operation(phase?: string): OperationRecord {
  return { id: 'self-deploy', requested_by: 'local', requester_peer_id: null, target: { kind: 'excubitor' }, action: 'deploy', source: 'origin', status: 'restarting', steps: [], last_step: null, error: null, created_at: 1, started_at: 1, finished_at: null, meta: { expected_hash: 'hash', ...(phase ? { service_recovery: { old, phase } } : {}) } };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.control.mockResolvedValue({ ok: true, payload: { kind: 'excubitor-status', state: 'running', pid: process.pid } });
  mocks.generation.mockResolvedValue(next);
  mocks.version.mockResolvedValue({ ...next, hash: 'hash' });
  mocks.plan.mockResolvedValue({ commands: [] });
  mocks.restart.mockResolvedValue(undefined);
  mocks.viewer.mockResolvedValue({ step: 'viewer', ok: true, detail: 'stopped, not started' });
});

describe('full-service self recovery', () => {
  it('persists intent before OS restart and waits for the new generation before viewer refresh', async () => {
    mocks.generation.mockResolvedValueOnce(old).mockResolvedValueOnce(old);
    mocks.restart.mockImplementation(async () => {
      expect(mocks.meta).toHaveBeenCalledWith('self-deploy', expect.objectContaining({ service_recovery: { old, phase: 'supervisor-issued' } }));
      expect(mocks.viewer).not.toHaveBeenCalled();
    });
    const op = operation();
    await recoverSelfService(op, 'hash', catalog, () => false);
    expect(mocks.restart).toHaveBeenCalledTimes(1);
    expect(op.meta.service_recovery).toEqual({ old, phase: 'viewer-verified' });
  });

  it('does not repeat an OS restart with an unknown command result after backend recovery', async () => {
    await recoverSelfService(operation('supervisor-issued'), 'hash', catalog, () => false);
    expect(mocks.plan).not.toHaveBeenCalled();
    expect(mocks.restart).not.toHaveBeenCalled();
    expect(mocks.viewer).toHaveBeenCalledTimes(1);
  });

  it('does not repeat an ambiguous viewer restart', async () => {
    await expect(recoverSelfService(operation('viewer-issued'), 'hash', catalog, () => false)).rejects.toThrow('result is unknown');
    expect(mocks.restart).not.toHaveBeenCalled();
    expect(mocks.viewer).not.toHaveBeenCalled();
  });

  it('retains issued intent and fails when the OS restart command fails', async () => {
    mocks.generation.mockResolvedValue(old);
    mocks.restart.mockRejectedValue(new Error('OS refused restart'));
    const op = operation();
    await expect(recoverSelfService(op, 'hash', catalog, () => false)).rejects.toThrow('OS refused');
    expect(op.meta.service_recovery).toEqual({ old, phase: 'supervisor-issued' });
    expect(mocks.viewer).not.toHaveBeenCalled();
  });
});
