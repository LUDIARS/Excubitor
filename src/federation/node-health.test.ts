import { describe, expect, it } from 'vitest';
import { buildHealthPayload } from './node-health.js';
import { NodeHealthPayloadSchema } from './health-types.js';
import type { HealthCacheSnapshot } from '../scanner/health-cache.js';
import type { NodeSnapshot } from './node-snapshot.js';
import type { ServiceCoverage } from './coverage.js';
import { nodeInfo } from './test-fixtures.js';

const snapshot: NodeSnapshot = {
  node: 'win',
  summary: { service: 'excubitor', services_total: 3, up: 1, down: 1, unknown: 1, open_errors: 0 },
  services: [
    { code: 'cernere', name: 'Cernere', state: 'running', port: 8080, git_branch: 'main' },
    { code: 'memoria', name: 'Memoria', state: 'stopped', port: 3000, git_branch: 'main' },
  ],
  host: { cpu_pct: 12 },
};

const coverage: ServiceCoverage[] = [
  { code: 'cernere', name: 'Cernere', project_code: 'Cr', kind: 'managed', covered: true, source: 'catalog' },
  { code: 'hora-app', name: 'Hora', project_code: 'Hr', kind: 'managed', covered: true, source: 'catalog' },
  { code: 'memoria', name: 'Memoria', project_code: 'Mm', kind: 'managed', covered: false, source: 'override' },
  { code: 'villa', name: 'Villa', project_code: null, kind: 'observed', covered: true, source: 'catalog' },
];

const cache: HealthCacheSnapshot = {
  startedAt: 900,
  completedAt: 1_000,
  durationMs: 100,
  intervalMs: 60_000,
  services: new Map([
    ['cernere', { ok: true, reason: 'http', detail: 'HTTP 200', reportedVersion: '1.2.0', checkedAt: 1_000 }],
    ['memoria', { ok: false, reason: 'failed', detail: 'fetch failed', reportedVersion: null, checkedAt: 1_000 }],
    ['villa', { ok: false, reason: 'not_configured', detail: null, reportedVersion: null, checkedAt: 1_000 }],
  ]),
};

describe('buildHealthPayload', () => {
  const payload = buildHealthPayload({ now: 2_000, snapshot, coverage, cache, links: [], nodeInfo: nodeInfo('win'), operations: [] });

  it('reports only cached health values, with the time each was checked', () => {
    const byCode = new Map(payload.services.map((svc) => [svc.code, svc]));
    expect(byCode.get('cernere')).toMatchObject({
      covered: true, kind: 'managed', state: 'running', port: 8080,
      health: { state: 'up', checked_at: 1_000, reported_version: '1.2.0' },
    });
    expect(byCode.get('memoria')).toMatchObject({ covered: false, source: 'override', health: { state: 'down' } });
    expect(byCode.get('villa')?.health.state).toBe('unmonitored');
    // 起動直後などで 1 周もしていないサービスは unknown (probe をその場で走らせない)。
    expect(byCode.get('hora-app')).toMatchObject({ state: 'unknown', health: { state: 'unknown', checked_at: null } });
  });

  it('carries scan timing so peers can judge freshness', () => {
    expect(payload).toMatchObject({
      node: 'win',
      generated_at: 2_000,
      scan: { started_at: 900, completed_at: 1_000, duration_ms: 100, interval_ms: 60_000 },
    });
  });

  it('matches the contract the receiving side validates against', () => {
    expect(NodeHealthPayloadSchema.safeParse(payload).success).toBe(true);
  });
});
