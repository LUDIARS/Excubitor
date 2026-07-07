import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { openDb, closeDb } from '../db/index.js';
import { db, resetDbClientForTests } from '../db/client.js';
import type { Service } from '../catalog/loader.js';
import {
  buildConcordiaInvokeBody,
  maybeDispatchCrashFixToConcordia,
} from './concordia-dispatch.js';
import { seedDefaultRules } from './seed.js';

const ORIGINAL_ENV = { ...process.env };

describe('Concordia crash dispatch', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    process.env.EXCUBITOR_CONCORDIA_URL = 'http://127.0.0.1:11111';
    resetDbClientForTests();
    closeDb();
    resetDbClientForTests();
    openDb(':memory:');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...ORIGINAL_ENV };
    closeDb();
    resetDbClientForTests();
  });

  it('builds a fix-bug invocation for an Anatomia crash issue', () => {
    const body = buildConcordiaInvokeBody({
      errorTaskId: 'task-12345678',
      service: anatomiaService(),
      severity: 'fatal',
      summary: '[Anatomia fatal crash] [anatomia-crash] uncaughtException: boom',
      logExcerpt: '[anatomia-crash] uncaughtException: boom',
      source: 'log',
    });

    expect(body.call_name).toBe('fix-bug');
    expect(body.cwd).toBe('E:\\Document\\Ars\\Anatomia');
    expect(body.branch).toBe('fix/anatomia-crash-task-123');
    expect(body.triggered_by).toBe('excubitor:error-task:task-12345678');
    expect(body.args.target_repo).toBe('E:\\Document\\Ars\\Anatomia');
    expect(String(body.args.description)).toContain('error_task task-12345678');
    expect(String(body.args.reproduce_steps)).toContain('[anatomia-crash]');
  });

  it('delegates a new Anatomia crash task to Concordia and records the run id', async () => {
    insertErrorTask('task-1');
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit): Promise<Response> =>
      new Response(JSON.stringify({ ok: true, run: { id: 'run-1' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await maybeDispatchCrashFixToConcordia({
      errorTaskId: 'task-1',
      service: anatomiaService(),
      severity: 'fatal',
      summary: '[Anatomia fatal crash] [anatomia-crash] uncaughtException: boom',
      logExcerpt: '[anatomia-crash] uncaughtException: boom',
      source: 'log',
    });

    expect(result).toMatchObject({ dispatched: true, runId: 'run-1', status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:11111/v1/delegation/invoke');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.call_name).toBe('fix-bug');
    expect(body.spawn).toBe(true);

    const row = readTask('task-1');
    expect(row.auto_fix_state).toBe('delegated_concordia');
    expect(row.auto_fix_run_id).toBe('run-1');
    expect(row.note).toContain('run=run-1');
  });

  it('skips non-Anatomia services', async () => {
    insertErrorTask('task-2');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await maybeDispatchCrashFixToConcordia({
      errorTaskId: 'task-2',
      service: { ...anatomiaService(), code: 'excubitor', name: 'Excubitor' } as Service,
      severity: 'fatal',
      summary: '[anatomia-crash] uncaughtException: boom',
      logExcerpt: '[anatomia-crash] uncaughtException: boom',
      source: 'log',
    });

    expect(result).toEqual({ dispatched: false, reason: 'not_anatomia_crash' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readTask('task-2').auto_fix_state).toBeNull();
  });

  it('marks dispatch failure when Concordia rejects the request', async () => {
    insertErrorTask('task-3');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad template', { status: 404 })));

    const result = await maybeDispatchCrashFixToConcordia({
      errorTaskId: 'task-3',
      service: anatomiaService(),
      severity: 'fatal',
      summary: '[Anatomia fatal crash] [anatomia-crash] uncaughtException: boom',
      logExcerpt: '[anatomia-crash] uncaughtException: boom',
      source: 'log',
    });

    expect(result.dispatched).toBe(false);
    expect(result.status).toBe(404);
    const row = readTask('task-3');
    expect(row.auto_fix_state).toBe('concordia_dispatch_failed');
    expect(row.note).toContain('HTTP 404');
  });

  it('seeds an Anatomia-scoped crash detector rule', async () => {
    await seedDefaultRules();
    const row = db().get(sql`
      SELECT pattern, service_codes
      FROM error_rules
      WHERE name = 'Anatomia fatal crash'
    `) as { pattern: string; service_codes: string } | undefined;

    expect(row).toBeDefined();
    expect(new RegExp(row!.pattern, 'i').test('[anatomia-crash] boom')).toBe(true);
    expect(JSON.parse(row!.service_codes)).toEqual(['anatomia']);
  });
});

function insertErrorTask(id: string): void {
  db().run(sql`
    INSERT INTO error_tasks (id, severity, summary, first_seen_at, last_seen_at)
    VALUES (${id}, 'fatal', 'placeholder', unixepoch() * 1000, unixepoch() * 1000)
  `);
}

function readTask(id: string): { auto_fix_state: string | null; auto_fix_run_id: string | null; note: string | null } {
  return db().get(sql`
    SELECT auto_fix_state, auto_fix_run_id, note
    FROM error_tasks
    WHERE id = ${id}
  `) as { auto_fix_state: string | null; auto_fix_run_id: string | null; note: string | null };
}

function anatomiaService(): Service {
  return {
    code: 'anatomia',
    name: 'Anatomia',
    runtime: 'node',
    cwd: 'E:\\Document\\Ars\\Anatomia',
    command: 'node bin/anatomia.mjs web',
    disabled: false,
    monitor_only: false,
    depends_on: [],
    autostart: false,
    restart_policy: 'no',
    max_restart: 5,
  } as unknown as Service;
}
