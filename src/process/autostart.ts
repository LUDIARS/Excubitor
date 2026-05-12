import pino from 'pino';
import type { Catalog } from '../catalog/loader.js';
import { spawnService, listRunningProcesses } from './manager.js';
import { resolveInjectEnv } from './inject.js';
import * as infisical from '../infisical/client.js';

const logger = pino({ name: 'excubitor.autostart' });

/**
 * catalog の autostart=true サービスを順次 spawn する。
 *
 * Infisical bootstrap が要求されるサービスは bootstrap 完了後に再度呼ぶ運用。
 * (Infisical bootstrap endpoint 経由で再 trigger するパスは v0.2)
 */
export async function runAutostart(
  catalog: Catalog,
): Promise<{ started: string[]; skipped: string[]; failed: string[] }> {
  const started: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];

  const running = new Set(listRunningProcesses().map((p) => p.code));

  for (const svc of catalog.services) {
    if (!svc.autostart) continue;
    if (svc.runtime !== 'node' && svc.runtime !== 'dev-process-md') {
      // docker-compose の autostart は別 module (v0.2)
      skipped.push(svc.code);
      continue;
    }
    if (running.has(svc.code)) {
      skipped.push(svc.code);
      continue;
    }
    if (svc.infisical?.inject && !infisical.isBootstrapped()) {
      logger.warn({ code: svc.code }, 'inject=true だが Infisical 未 bootstrap、 skip');
      skipped.push(svc.code);
      continue;
    }
    try {
      const env = await resolveInjectEnv(svc);
      await spawnService(svc, { env });
      started.push(svc.code);
    } catch (err) {
      logger.error({ code: svc.code, err: (err as Error).message }, 'autostart failed');
      failed.push(svc.code);
    }
  }

  logger.info({ started, skipped, failed }, 'autostart complete');
  return { started, skipped, failed };
}
