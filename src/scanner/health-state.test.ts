import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { openDb, closeDb } from '../db/index.js';
import { db, resetDbClientForTests } from '../db/client.js';
import type { Catalog } from '../catalog/loader.js';
import type { ServiceHealthResult } from './health.js';

const healthMock = vi.hoisted(() => ({
  results: new Map<string, ServiceHealthResult>(),
}));

vi.mock('./health.js', () => ({
  serviceHealthResults: vi.fn(async () => healthMock.results),
}));

import { syncHealthyServiceStates } from './health-state.js';

describe('syncHealthyServiceStates', () => {
  beforeEach(() => {
    resetDbClientForTests();
    closeDb();
    resetDbClientForTests();
    openDb(':memory:');
    seedService('concordia', 'running', 123);
    healthMock.results = new Map();
  });

  afterEach(() => {
    closeDb();
    resetDbClientForTests();
  });

  it('marks a service stopped and records a failed liveness sample when health fails', async () => {
    healthMock.results = new Map([
      ['concordia', { ok: false, reason: 'failed', detail: 'fetch failed' }],
    ]);

    const result = await syncHealthyServiceStates(catalog('concordia'));

    expect(result).toMatchObject({ checked: 1, running: [], stopped: ['concordia'] });
    expect(readInstanceState('concordia')).toMatchObject({ state: 'stopped', last_seen_at: 123 });
    const live = readLatestLiveness('concordia');
    expect(Boolean(live?.ok)).toBe(false);
    expect(JSON.parse(String(live?.detail))).toEqual({
      source: 'health',
      reason: 'failed',
      detail: 'fetch failed',
    });
  });

  it('marks a service running and records an ok liveness sample when health passes', async () => {
    healthMock.results = new Map([
      ['concordia', { ok: true, reason: 'http', detail: 'HTTP 200' }],
    ]);

    const result = await syncHealthyServiceStates(catalog('concordia'));

    expect(result.running).toEqual(['concordia']);
    expect(readInstanceState('concordia')?.state).toBe('running');
    const live = readLatestLiveness('concordia');
    expect(Boolean(live?.ok)).toBe(true);
    expect(JSON.parse(String(live?.detail))).toMatchObject({ source: 'health', reason: 'http' });
  });

  it('does not overwrite state for services without a health signal', async () => {
    healthMock.results = new Map([
      ['concordia', { ok: false, reason: 'not_configured' }],
    ]);

    const result = await syncHealthyServiceStates(catalog('concordia'));

    expect(result).toMatchObject({ checked: 1, running: [], stopped: [] });
    expect(readInstanceState('concordia')?.state).toBe('running');
    expect(readLatestLiveness('concordia')).toBeUndefined();
  });
});

function seedService(code: string, state: string, lastSeenAt: number): void {
  db().run(sql`
    INSERT INTO services (id, code, name, catalog_snapshot)
    VALUES (${`${code}-svc`}, ${code}, ${code}, '{}')
  `);
  db().run(sql`
    INSERT INTO service_instances (id, service_id, state, last_seen_at)
    VALUES (${`${code}-inst`}, ${`${code}-svc`}, ${state}, ${lastSeenAt})
  `);
}

function catalog(code: string): Catalog {
  return {
    services: [
      {
        code,
        name: code,
        runtime: 'node',
        disabled: false,
        monitor_only: false,
      },
    ],
    memory_monitor: {},
  } as unknown as Catalog;
}

function readInstanceState(code: string): { state: string; last_seen_at: number | null } | undefined {
  return db().get(sql`
    SELECT si.state, si.last_seen_at
    FROM service_instances si
    JOIN services s ON s.id = si.service_id
    WHERE s.code = ${code}
  `) as { state: string; last_seen_at: number | null } | undefined;
}

function readLatestLiveness(code: string): { ok: unknown; detail: unknown } | undefined {
  return db().get(sql`
    SELECT lh.ok, lh.detail
    FROM liveness_history lh
    JOIN service_instances si ON si.id = lh.service_instance_id
    JOIN services s ON s.id = si.service_id
    WHERE s.code = ${code}
    ORDER BY lh.id DESC
    LIMIT 1
  `) as { ok: unknown; detail: unknown } | undefined;
}
