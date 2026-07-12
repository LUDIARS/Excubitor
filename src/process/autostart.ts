import { createNamedLogger } from '../shared/logger.js';
import type { Catalog } from '../catalog/loader.js';
import { spawnService, isManaged } from './manager.js';
import { resolveInjectEnv } from './inject.js';

const logger = createNamedLogger('concordia.observability.autostart');

/**
 * catalog の autostart=true サービスを頁E�� spawn する.
 *
 * Infisical 連携は廁E��: 吁E��ービスが�E前で Infisical fetch を行う前提.
 * (Excubitor 由来の relay 機構を Concordia 統合時に外しぁE 2026-05-17)
 */
export async function runAutostart(
  catalog: Catalog,
  shouldStop?: () => boolean,
): Promise<{ started: string[]; skipped: string[]; failed: string[] }> {
  const started: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];

  for (const svc of catalog.services) {
    if (shouldStop?.()) break;
    if (!svc.autostart) continue;
    if (svc.disabled) {
      skipped.push(svc.code);
      continue;
    }
    // app は GUI 製品なので既定では autostart しないが、 catalog で autostart=true を
    // 明示したものは opt-in として起動する (node / dev-process-md と同じ spawn 経路)。
    if (svc.runtime !== 'node' && svc.runtime !== 'dev-process-md' && svc.runtime !== 'app') {
      skipped.push(svc.code);
      continue;
    }
    // 再採用済み (detached で既に稼働中) は二重起動しない。
    if (isManaged(svc.code)) {
      skipped.push(svc.code);
      continue;
    }
    try {
      const env = await resolveInjectEnv(svc);
      if (shouldStop?.()) break;
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


