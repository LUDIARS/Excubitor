import { sql } from 'drizzle-orm';

import { db } from '../db/client.js';

interface RestartBudgetRow {
  restart_count: number | null;
}

const RESTART_COUNT_PATH = '$.__excubitor_restart_count';

/** Supervisor の再起動をまたいで保持する自動再起動回数。 */
export function readServiceRestartCount(code: string): number {
  const row = db().get(sql`
    SELECT CAST(json_extract(
      CASE WHEN json_valid(si.extra) THEN si.extra ELSE '{}' END,
      ${RESTART_COUNT_PATH}
    ) AS INTEGER) AS restart_count
    FROM service_instances si
    JOIN services s ON s.id = si.service_id
    WHERE s.code = ${code}
    LIMIT 1
  `) as RestartBudgetRow | undefined;
  const value = Number(row?.restart_count ?? 0);
  return Number.isInteger(value) && value > 0 ? value : 0;
}

/** 自動再起動を予約する前に永続カウンタを進める。 */
export function writeServiceRestartCount(code: string, restartCount: number): void {
  const value = Math.max(0, Math.trunc(restartCount));
  db().run(sql`
    UPDATE service_instances
    SET extra = json_set(
          CASE WHEN json_valid(extra) THEN extra ELSE '{}' END,
          ${RESTART_COUNT_PATH},
          ${value}
        ),
        updated_at = unixepoch() * 1000
    WHERE service_id IN (SELECT id FROM services WHERE code = ${code})
  `);
}

/** オペレータによる明示 start/restart だけが circuit breaker を解除する。 */
export function resetServiceRestartCount(code: string): void {
  writeServiceRestartCount(code, 0);
}
