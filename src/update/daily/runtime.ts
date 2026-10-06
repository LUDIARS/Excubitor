/** @implements SPEC-EX-DAILY-SITE-DEPLOY */
import { setTimeout as delay } from 'node:timers/promises';
import type { Catalog, Service } from '../../catalog/loader.js';
import { isLocalProcessRuntime } from '../../catalog/runtime-kind.js';
import { controlService } from '../../control/manager.js';
import { validateManagedProcess } from '../../process/manager.js';
import { probeServiceHealth } from '../../scanner/health.js';
import type { ExcubitorBackendController } from '../../local-control/excubitor-backend.js';
import { dailyCommand } from './command.js';

export interface DailyRuntime {
  catalog: () => Promise<Catalog>;
  running: (svc: Service) => Promise<boolean>;
  stop: (svc: Service) => Promise<void>;
  start: (svc: Service) => Promise<void>;
  healthy: (svc: Service) => Promise<boolean>;
}
export function createDailyRuntime(backend: ExcubitorBackendController, catalog: () => Promise<Catalog>): DailyRuntime {
  const running = async (svc: Service): Promise<boolean> => {
    if (svc.code === 'excubitor') return backend.status().state === 'running';
    if (isLocalProcessRuntime(svc.runtime)) return validateManagedProcess(svc.code);
    if (svc.runtime !== 'docker-compose' || !svc.compose_file) throw new Error(`unsupported lifecycle: ${svc.code}`);
    const output = await dailyCommand('docker', ['compose', '-f', svc.compose_file, 'ps', '--all', '--format', 'json', ...(svc.services ?? [])], svc.cwd ?? process.cwd());
    const rows: { State?: string }[] = !output ? [] : output.startsWith('[') ? JSON.parse(output) : output.split('\n').map((line) => JSON.parse(line));
    const live = rows.filter((row) => row.State === 'running').length;
    if (live && live !== rows.length) throw new Error(`mixed container state: ${svc.code}`);
    return live > 0;
  };
  return {
    catalog, running,
    stop: async (svc) => {
      if (svc.code === 'excubitor') { await backend.stop(); return; }
      // stop is still required after a failed start to cancel scheduled process recovery.
      const result = await controlService(svc, 'stop', 'daily-update');
      if (!result.ok && await running(svc)) throw new Error(`stop failed: ${svc.code}`);
    },
    start: async (svc) => {
      if (svc.code === 'excubitor') { await backend.start(); return; }
      const result = await controlService(svc, svc.runtime === 'docker-compose' ? 'restart' : 'start', 'daily-update');
      if (!result.ok) throw new Error(`start failed: ${svc.code}`);
    },
    healthy: async (svc) => {
      if (!await running(svc)) return false;
      if (svc.code === 'excubitor') return true; // controller.start waits for authenticated backend readiness
      if (isLocalProcessRuntime(svc.runtime) && (!svc.health || svc.health.type === 'process')) return true;
      return (await probeServiceHealth(svc)).ok;
    },
  };
}
export async function waitDailyHealthy(services: Service[], runtime: DailyRuntime, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let consecutive = 0;
  do {
    const healthy = (await Promise.all(services.map((svc) => runtime.healthy(svc)))).every(Boolean);
    consecutive = healthy ? consecutive + 1 : 0;
    if (consecutive >= 3) return;
    await delay(2_000);
  } while (Date.now() < deadline);
  throw new Error('startup health verification failed');
}
