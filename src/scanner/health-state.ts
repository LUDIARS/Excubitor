import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { Catalog } from '../catalog/loader.js';
import { createNamedLogger } from '../shared/logger.js';
import { healthyServiceCodes, type ServiceHealthResult } from './health.js';

const logger = createNamedLogger('excubitor.health-state');

export interface HealthStateSyncResult {
  checked: number;
  running: string[];
}

export async function syncHealthyServiceStates(catalog: Catalog): Promise<HealthStateSyncResult> {
  const healthy = await healthyServiceCodes(catalog);
  const running: string[] = [];
  for (const svc of catalog.services) {
    const result = healthy.get(svc.code);
    if (!result) continue;
    markServiceRunning(svc.code, result);
    running.push(svc.code);
  }
  if (running.length > 0) {
    logger.info({ running }, 'health scan marked services running');
  }
  return { checked: catalog.services.length, running };
}

function markServiceRunning(code: string, result: ServiceHealthResult): void {
  db().run(sql`
    INSERT INTO service_instances (id, service_id, state, created_at, updated_at)
    SELECT lower(hex(randomblob(16))), s.id, 'pending', unixepoch() * 1000, unixepoch() * 1000
    FROM services s
    WHERE s.code = ${code}
      AND NOT EXISTS (SELECT 1 FROM service_instances si WHERE si.service_id = s.id)
  `);

  db().run(sql`
    UPDATE service_instances
    SET state = 'running',
        last_seen_at = unixepoch() * 1000,
        updated_at = unixepoch() * 1000
    WHERE service_id IN (SELECT id FROM services WHERE code = ${code})
  `);

  db().run(sql`
    INSERT INTO liveness_history (service_instance_id, ok, detail)
    SELECT si.id, 1, ${JSON.stringify({ source: 'health', reason: result.reason, detail: result.detail ?? null })}
    FROM service_instances si
    JOIN services s ON s.id = si.service_id
    WHERE s.code = ${code}
    LIMIT 1
  `);
}
