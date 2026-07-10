/**
 * 実 SQLite (in-memory) で retention 剪定の SQL 経路を検証する。
 * store.test.ts と同方針: fake では列名・方言の実バグを拾えないため実 DB に実走する。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { openDb } from './index.js';
import { db } from './client.js';
import { sweepRetentionOnce } from './retention.js';

const INSTANCE_ID = 'inst-ret-1';
const SERVICE_ID = 'svc-ret-1';

const RETENTION = {
  enabled: true,
  logs_hours: 72,
  liveness_hours: 168,
  interval_min: 60,
  batch_rows: 3, // バッチ跨ぎのループも検証するため小さく
};

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

function countRows(table: 'service_instance_logs' | 'liveness_history'): number {
  const row = db().all(sql`SELECT COUNT(*) AS n FROM ${sql.raw(table)}`) as Array<{ n: number }>;
  return row[0]!.n;
}

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

describe('sweepRetentionOnce', () => {
  it('cutoff より古い行だけをバッチ跨ぎで削除する', () => {
    // logs: 古い 7 行 (batch_rows=3 を跨ぐ) + 新しい 2 行
    for (let i = 0; i < 7; i++) {
      db().run(sql`
        INSERT INTO service_instance_logs (service_instance_id, ts, level, line)
        VALUES (${INSTANCE_ID}, ${NOW - (RETENTION.logs_hours + 1 + i) * HOUR}, 'info', ${'old-' + i})
      `);
    }
    for (let i = 0; i < 2; i++) {
      db().run(sql`
        INSERT INTO service_instance_logs (service_instance_id, ts, level, line)
        VALUES (${INSTANCE_ID}, ${NOW - i * HOUR}, 'info', ${'fresh-' + i})
      `);
    }
    // liveness: 古い 4 行 + 新しい 1 行
    for (let i = 0; i < 4; i++) {
      db().run(sql`
        INSERT INTO liveness_history (service_instance_id, probed_at, ok)
        VALUES (${INSTANCE_ID}, ${NOW - (RETENTION.liveness_hours + 1 + i) * HOUR}, 1)
      `);
    }
    db().run(sql`
      INSERT INTO liveness_history (service_instance_id, probed_at, ok)
      VALUES (${INSTANCE_ID}, ${NOW - HOUR}, 1)
    `);

    const r = sweepRetentionOnce(RETENTION, NOW);

    expect(r.logsDeleted).toBe(7);
    expect(r.livenessDeleted).toBe(4);
    expect(countRows('service_instance_logs')).toBe(2);
    expect(countRows('liveness_history')).toBe(1);
  });

  it('削除対象が無ければ 0 を返す', () => {
    const r = sweepRetentionOnce(RETENTION, NOW);
    expect(r.logsDeleted).toBe(0);
    expect(r.livenessDeleted).toBe(0);
    expect(countRows('service_instance_logs')).toBe(2);
  });
});
