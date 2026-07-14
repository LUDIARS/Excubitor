import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, openDb } from '../db/index.js';
import { db, resetDbClientForTests } from '../db/client.js';
import type { Catalog, Service } from '../catalog/loader.js';
import { retryPendingConcordiaDispatches } from './concordia-dispatch-loop.js';

describe('Concordia dispatch retry loop', () => {
  beforeEach(() => {
    resetDbClientForTests();
    closeDb();
    resetDbClientForTests();
    openDb(':memory:');
    db().run(sql`INSERT INTO services (id, code, name, catalog_snapshot) VALUES ('s', 'anatomia', 'Anatomia', '{}')`);
    db().run(sql`INSERT INTO service_instances (id, service_id, state) VALUES ('si', 's', 'running')`);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    closeDb();
    resetDbClientForTests();
  });

  it('reconciles a timed-out request without creating a duplicate run', async () => {
    insertPending('task-existing', 'concordia_dispatch_failed', 1);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      runs: [{ id: 'run-existing', triggered_by: 'excubitor:error-task:task-existing' }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const completed = await retryPendingConcordiaDispatches(catalog(), 10_000);

    expect(completed).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readDispatch('task-existing')).toEqual({
      auto_fix_state: 'delegated_concordia',
      auto_fix_run_id: 'run-existing',
    });
  });

  it('retries when reconciliation confirms that no run exists', async () => {
    insertPending('task-missing', 'concordia_dispatch_failed', 1);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ runs: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ run: { id: 'run-new' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const completed = await retryPendingConcordiaDispatches(catalog(), 10_000);

    expect(completed).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(readDispatch('task-missing')).toEqual({
      auto_fix_state: 'delegated_concordia',
      auto_fix_run_id: 'run-new',
    });
  });

  it('does not create a duplicate when reconciliation returns an invalid response', async () => {
    insertPending('task-invalid-response', 'concordia_dispatch_failed', 1);
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const completed = await retryPendingConcordiaDispatches(catalog(), 10_000);

    expect(completed).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readDispatch('task-invalid-response')).toEqual({
      auto_fix_state: 'concordia_dispatch_failed',
      auto_fix_run_id: null,
    });
  });
});

function insertPending(id: string, state: string, nextAt: number): void {
  db().run(sql`
    INSERT INTO error_tasks (
      id, service_instance_id, severity, summary, log_excerpt,
      first_seen_at, last_seen_at, auto_fix_state, issue_dispatch_next_at
    ) VALUES (
      ${id}, 'si', 'fatal', '[Anatomia fatal crash] [anatomia-crash] boom',
      '[anatomia-crash] boom', 1, 1, ${state}, ${nextAt}
    )
  `);
}

function readDispatch(id: string): { auto_fix_state: string; auto_fix_run_id: string | null } {
  return db().get(sql`
    SELECT auto_fix_state, auto_fix_run_id FROM error_tasks WHERE id = ${id}
  `) as { auto_fix_state: string; auto_fix_run_id: string | null };
}

function catalog(): Catalog {
  return {
    services: [{
      code: 'anatomia',
      name: 'Anatomia',
      cwd: 'E:\\Document\\Ars\\Anatomia',
      runtime: 'node',
    } as Service],
  } as Catalog;
}
