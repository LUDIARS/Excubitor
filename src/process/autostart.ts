import { createNamedLogger } from '../shared/logger.js';
import type { Catalog } from '../catalog/loader.js';
import { spawnService, listRunningProcesses } from './manager.js';
import { resolveInjectEnv } from './inject.js';

const logger = createNamedLogger('concordia.observability.autostart');

/**
 * catalog 縺ｮ autostart=true 繧ｵ繝ｼ繝薙せ繧帝・ｬ｡ spawn 縺吶ｋ.
 *
 * Infisical 騾｣謳ｺ縺ｯ蟒・ｭ｢: 蜷・し繝ｼ繝薙せ縺瑚・蜑阪〒 Infisical fetch 繧定｡後≧蜑肴署.
 * (Excubitor 逕ｱ譚･縺ｮ relay 讖滓ｧ九ｒ Concordia 邨ｱ蜷域凾縺ｫ螟悶＠縺・ 2026-05-17)
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
      skipped.push(svc.code);
      continue;
    }
    if (running.has(svc.code)) {
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


