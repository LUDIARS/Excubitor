import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, openDb } from '../db/index.js';
import { db, resetDbClientForTests } from '../db/client.js';
import { publish } from './bus.js';
import { startErrorDetector, type ErrorDetectorHandle } from './error-detector.js';

describe('error detector issue deduplication', () => {
  let handle: ErrorDetectorHandle | undefined;

  beforeEach(() => {
    resetDbClientForTests();
    closeDb();
    resetDbClientForTests();
    openDb(':memory:');
    db().run(sql`INSERT INTO services (id, code, name, catalog_snapshot) VALUES ('s', 'svc', 'Service', '{}')`);
    db().run(sql`INSERT INTO service_instances (id, service_id, state) VALUES ('si', 's', 'running')`);
    db().run(sql`
      INSERT INTO error_rules (id, name, pattern, pattern_type, severity)
      VALUES ('r', 'boom', 'BOOM', 'keyword', 'error')
    `);
  });

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    closeDb();
    resetDbClientForTests();
  });

  it('updates the existing unresolved issue instead of opening one every minute', async () => {
    handle = await startErrorDetector();
    const line = { service_code: 'svc', channel: 'stderr' as const, ts: new Date(), line: 'BOOM' };
    await publish(line);
    await vi.waitFor(() => expect(issueRows()).toEqual([{ occurrence_count: 1 }]));
    await publish(line);
    await vi.waitFor(() => expect(issueRows()).toEqual([{ occurrence_count: 2 }]));
  });
});

function issueRows(): Array<{ occurrence_count: number }> {
  return db().all(sql`SELECT occurrence_count FROM error_tasks ORDER BY created_at`) as Array<{ occurrence_count: number }>;
}
