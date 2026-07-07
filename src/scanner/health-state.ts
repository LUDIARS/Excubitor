import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { Catalog } from '../catalog/loader.js';
import { createNamedLogger } from '../shared/logger.js';
import { serviceHealthResults, type ServiceHealthResult } from './health.js';

const logger = createNamedLogger('excubitor.health-state');

export interface HealthStateSyncResult {
  checked: number;
  running: string[];
  stopped: string[];
}

export async function syncHealthyServiceStates(catalog: Catalog): Promise<HealthStateSyncResult> {
  const results = await serviceHealthResults(catalog);
  const running: string[] = [];
  const stopped: string[] = [];
  for (const svc of catalog.services) {
    const result = results.get(svc.code);
    if (!result) continue;
    if (result.reason === 'not_configured') continue;
    markServiceHealth(svc.code, result);
    if (result.ok) running.push(svc.code);
    else stopped.push(svc.code);
  }
  if (running.length > 0 || stopped.length > 0) {
    logger.info({ running, stopped }, 'health scan updated service states');
  }
  return { checked: catalog.services.length, running, stopped };
}

function markServiceHealth(code: string, result: ServiceHealthResult): void {
  const state = result.ok ? 'running' : 'stopped';
  db().run(sql`
    INSERT INTO service_instances (id, service_id, state, created_at, updated_at)
    SELECT lower(hex(randomblob(16))), s.id, 'pending', unixepoch() * 1000, unixepoch() * 1000
    FROM services s
    WHERE s.code = ${code}
      AND NOT EXISTS (SELECT 1 FROM service_instances si WHERE si.service_id = s.id)
  `);

  db().run(sql`
    UPDATE service_instances
    SET state = ${state},
        last_seen_at = CASE WHEN ${result.ok ? 1 : 0} = 1 THEN unixepoch() * 1000 ELSE last_seen_at END,
        updated_at = unixepoch() * 1000
    WHERE service_id IN (SELECT id FROM services WHERE code = ${code})
  `);

  db().run(sql`
    INSERT INTO liveness_history (service_instance_id, ok, detail)
    SELECT si.id, ${result.ok ? 1 : 0}, ${JSON.stringify({ source: 'health', reason: result.reason, detail: result.detail ?? null })}
    FROM service_instances si
    JOIN services s ON s.id = si.service_id
    WHERE s.code = ${code}
    LIMIT 1
  `);
}
