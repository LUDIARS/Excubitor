import { beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from './client.js';
import { openDb } from './index.js';
import { sweepRetentionOnce } from './retention.js';

const INSTANCE_ID = 'inst-ret-1';
const SERVICE_ID = 'svc-ret-1';
const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const RETENTION = {
  enabled: true,
  logs_hours: 72,
  liveness_hours: 168,
  parquet_days: 90,
  interval_min: 60,
  batch_rows: 3,
};

beforeAll(() => {
  openDb(':memory:');
  db().run(sql`
    INSERT INTO services (id, code, name, catalog_snapshot)
    VALUES (${SERVICE_ID}, 'retention-target', 'Retention target', '{}')
  `);
  db().run(sql`
    INSERT INTO service_instances (id, service_id, state, pid)
    VALUES (${INSTANCE_ID}, ${SERVICE_ID}, 'running', 4242)
  `);
});

function countRows(): number {
  const rows = db().all(sql`SELECT COUNT(*) AS n FROM liveness_history`) as Array<{ n: number }>;
  return rows[0]!.n;
}

describe('sweepRetentionOnce', () => {
  it('cutoff より古い死活履歴だけをバッチ跨ぎで削除する', () => {
    for (let index = 0; index < 7; index += 1) {
      db().run(sql`
        INSERT INTO liveness_history (service_instance_id, probed_at, ok)
        VALUES (${INSTANCE_ID}, ${NOW - (RETENTION.liveness_hours + 1 + index) * HOUR}, 1)
      `);
    }
    db().run(sql`
      INSERT INTO liveness_history (service_instance_id, probed_at, ok)
      VALUES (${INSTANCE_ID}, ${NOW - HOUR}, 1)
    `);

    expect(sweepRetentionOnce(RETENTION, NOW)).toEqual({ livenessDeleted: 7 });
    expect(countRows()).toBe(1);
  });

  it('削除対象が無ければ 0 を返す', () => {
    expect(sweepRetentionOnce(RETENTION, NOW)).toEqual({ livenessDeleted: 0 });
    expect(countRows()).toBe(1);
  });
});
