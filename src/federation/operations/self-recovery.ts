import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { Catalog } from '../../catalog/loader.js';
import { requestLocalControl } from '../../local-control/client.js';
import { planSupervisorRestart, restartInstalledSupervisor } from '../../local-control/supervisor-service-restart.js';
import { readSupervisorGeneration, readSupervisorVersion, type SupervisorGeneration } from '../../local-control/supervisor-version.js';
import { appendStep, updateOperationMeta, type OperationRecord } from './store.js';
import { refreshSelfViewer } from './self-viewer.js';

/** @implements SPEC-EX-UNIFIED-UPDATE */
const RecoverySchema = z.object({
  old: z.object({ pid: z.number().int().positive(), started_at: z.string() }),
  phase: z.enum(['supervisor-issued', 'supervisor-verified', 'viewer-issued', 'viewer-verified']),
});
const RECOVERY_TIMEOUT_MS = 120_000;

async function backendReady(): Promise<boolean> {
  try {
    const result = await requestLocalControl({ target: { kind: 'excubitor' }, action: 'status', actor: 'excubitor-self-recovery' }, { timeoutMs: 2_000 });
    return result.ok && result.payload?.kind === 'excubitor-status' && result.payload.state === 'running' && result.payload.pid === process.pid;
  } catch {
    return false; // Expected while the OS manager replaces the IPC owner. The bounded wait below reports failure.
  }
}

async function waitFor(check: () => Promise<boolean>, shouldStop: () => boolean): Promise<void> {
  const deadline = Date.now() + RECOVERY_TIMEOUT_MS;
  while (!shouldStop() && Date.now() < deadline) {
    if (await check()) return;
    await delay(500);
  }
  throw new Error(shouldStop() ? 'Self update interrupted during recovery' : 'Supervisor recovery verification timed out; do not resend the update automatically');
}

function replaced(current: SupervisorGeneration, old: SupervisorGeneration): boolean {
  return current.pid !== old.pid || current.started_at !== old.started_at;
}

export async function recoverSelfService(
  op: OperationRecord,
  expected: string,
  catalog: Catalog,
  shouldStop: () => boolean,
): Promise<void> {
  const root = catalog.services.find(service => service.code === 'excubitor')?.cwd ?? process.cwd();
  let recovery = op.meta.service_recovery ? RecoverySchema.parse(op.meta.service_recovery) : null;
  const save = (value: z.infer<typeof RecoverySchema>): void => {
    recovery = value;
    op.meta = { ...op.meta, service_recovery: value };
    updateOperationMeta(op.id, op.meta);
  };
  if (!recovery) {
    // Let the old supervisor finish its deferred backend restart before restarting its OS job.
    // This runs asynchronously after boot; it must not block the backend HTTP listener from starting.
    await waitFor(backendReady, shouldStop);
    const old = await readSupervisorGeneration(root);
    const plan = await planSupervisorRestart(old);
    const current = await readSupervisorGeneration(root);
    if (replaced(current, old)) throw new Error('Supervisor changed during restart preparation');
    if (shouldStop()) throw new Error('Self update interrupted before OS restart');
    save({ old, phase: 'supervisor-issued' }); // Durable intent before mutation: never reissue an ambiguous restart.
    await restartInstalledSupervisor(plan);
    appendStep(op.id, { step: 'supervisor_restart', ok: true, detail: 'OS service restart accepted' });
  }
  const state = RecoverySchema.parse(op.meta.service_recovery);
  await waitFor(async () => {
    const version = await readSupervisorVersion(root);
    const current = await readSupervisorGeneration(root);
    return version !== null && version.pid === current.pid && version.started_at === current.started_at
      && replaced(current, state.old) && version.hash === expected && await backendReady();
  }, shouldStop);
  if (state.phase === 'viewer-issued') throw new Error('ExView restart result is unknown; inspect service state before retrying');
  if (state.phase === 'viewer-verified') return;
  save({ old: state.old, phase: 'supervisor-verified' });
  appendStep(op.id, { step: 'supervisor', ok: true, detail: 'New supervisor process is ready at ' + expected });
  const viewer = catalog.services.find(service => service.code === 'excubitor-viewer-dmz');
  if (viewer) {
    if (shouldStop()) throw new Error('Self update interrupted before ExView refresh');
    save({ old: state.old, phase: 'viewer-issued' });
    const step = await refreshSelfViewer(viewer, 'excubitor-self-recovery');
    appendStep(op.id, step);
    if (!step.ok) throw new Error(step.detail);
  }
  save({ old: state.old, phase: 'viewer-verified' });
}
