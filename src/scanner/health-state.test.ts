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

import { shouldRecordLiveness, syncHealthyServiceStates } from './health-state.js';

describe('shouldRecordLiveness', () => {
  it('records the first sample, every transition, and a heartbeat when nothing changes', () => {
    expect(shouldRecordLiveness(null, true, 0, 300_000)).toBe(true);
    expect(shouldRecordLiveness({ ok: true, probedAt: 0 }, false, 1, 300_000)).toBe(true);
    expect(shouldRecordLiveness({ ok: true, probedAt: 0 }, true, 299_999, 300_000)).toBe(false);
    expect(shouldRecordLiveness({ ok: true, probedAt: 0 }, true, 300_000, 300_000)).toBe(true);
  });
});

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
      ['concordia', { ok: true, reason: 'http', detail: 'HTTP 200', reportedVersion: '0.1.0' }],
    ]);

    const result = await syncHealthyServiceStates(catalog('concordia'));

    expect(result.running).toEqual(['concordia']);
    expect(readInstanceState('concordia')).toMatchObject({ state: 'running', reported_version: '0.1.0' });
    const live = readLatestLiveness('concordia');
    expect(Boolean(live?.ok)).toBe(true);
    expect(JSON.parse(String(live?.detail))).toMatchObject({ source: 'health', reason: 'http' });
  });

  it('writes liveness only on a state change or after the heartbeat interval', async () => {
    healthMock.results = new Map([
      ['concordia', { ok: true, reason: 'http', detail: 'HTTP 200' }],
    ]);
    let now = 1_000_000;
    const options = { now: () => now, livenessHeartbeatMs: 300_000 };

    await syncHealthyServiceStates(catalog('concordia'), options);
    now += 60_000;
    await syncHealthyServiceStates(catalog('concordia'), options);
    expect(countLiveness('concordia')).toBe(1);

    healthMock.results = new Map([
      ['concordia', { ok: false, reason: 'failed', detail: 'fetch failed' }],
    ]);
    now += 60_000;
    await syncHealthyServiceStates(catalog('concordia'), options);
    expect(countLiveness('concordia')).toBe(2);

    now += 300_000;
    await syncHealthyServiceStates(catalog('concordia'), options);
    expect(countLiveness('concordia')).toBe(3);
    // 状態 (service_instances) は liveness を書かない周でも毎回更新される。
    expect(readInstanceState('concordia')?.state).toBe('stopped');
  });

  it('returns the raw probe results for the health cache', async () => {
    healthMock.results = new Map([
      ['concordia', { ok: false, reason: 'not_configured' }],
    ]);
    const result = await syncHealthyServiceStates(catalog('concordia'));
    expect(result.results.get('concordia')).toEqual({ ok: false, reason: 'not_configured' });
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

function readInstanceState(code: string): {
  state: string;
  last_seen_at: number | null;
  reported_version: string | null;
} | undefined {
  return db().get(sql`
    SELECT si.state, si.last_seen_at, si.reported_version
    FROM service_instances si
    JOIN services s ON s.id = si.service_id
    WHERE s.code = ${code}
  `) as { state: string; last_seen_at: number | null; reported_version: string | null } | undefined;
}

function countLiveness(code: string): number {
  const row = db().get(sql`
    SELECT COUNT(*) AS n
    FROM liveness_history lh
    JOIN service_instances si ON si.id = lh.service_instance_id
    JOIN services s ON s.id = si.service_id
    WHERE s.code = ${code}
  `) as { n: number };
  return Number(row.n);
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
