/**
 * boot 時のプロセス状態の再構築 (永続化された service_instances と実プロセスの突合)。
 *
 * Excubitor は子サービスを detached で起動するため、 Excubitor 自身が再起動しても
 * サービスは生き続ける。 boot 時に DB に残った running/pending な node/dev-process-md
 * インスタンスの pid を生存確認し:
 *   - 生存 → adoptProcess() で再採用 (stop 可能・状態は running 維持)
 *   - 死亡 → state を crashed に落とす (stale な running を解消)
 *
 * docker サービスは scanner が別途実体と同期するため対象外。
 */

import { sql } from 'drizzle-orm';
import { createNamedLogger } from '../shared/logger.js';
import { db } from '../db/client.js';
import type { Catalog } from '../catalog/loader.js';
import { adoptProcess, isPidAlive } from './manager.js';

const logger = createNamedLogger('excubitor.process.reconcile');

interface PersistedInstance {
  code: string;
  pid: number | null;
  state: string;
  started_at: number | null;
}

export interface ReconcileResult {
  adopted: string[];
  crashed: string[];
}

/** node / dev-process-md / app のうち、 DB 上 running/pending な行を実プロセスと突合する。 */
export function reconcileProcesses(catalog: Catalog): ReconcileResult {
  const processRuntimes = new Set(
    catalog.services
      .filter((s) => s.runtime === 'node' || s.runtime === 'dev-process-md' || s.runtime === 'app')
      .map((s) => s.code),
  );

  const rows = db().all(sql`
    SELECT s.code AS code, si.pid AS pid, si.state AS state, si.started_at AS started_at
    FROM service_instances si
    JOIN services s ON s.id = si.service_id
    WHERE si.state IN ('running', 'pending')
  `) as PersistedInstance[];

  const result: ReconcileResult = { adopted: [], crashed: [] };

  for (const row of rows) {
    if (!processRuntimes.has(row.code)) continue; // docker 等は scanner 任せ
    if (row.pid && isPidAlive(row.pid)) {
      adoptProcess(row.code, row.pid, row.started_at ? new Date(row.started_at) : new Date());
      result.adopted.push(row.code);
    } else {
      db().run(sql`
        UPDATE service_instances
        SET state = 'crashed', pid = NULL, updated_at = unixepoch() * 1000
        WHERE service_id IN (SELECT id FROM services WHERE code = ${row.code})
      `);
      result.crashed.push(row.code);
    }
  }

  if (result.adopted.length || result.crashed.length) {
    logger.info(result, 'reconciled persisted process instances');
  }
  return result;
}
