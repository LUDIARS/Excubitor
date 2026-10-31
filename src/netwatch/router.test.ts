/** @implements SPEC-EX-NETWATCH */
import { describe, expect, it } from 'vitest';
import { buildNetwatchRouter } from './router.js';
import type { NetwatchSnapshot } from './runtime.js';
import type { AssessedDestination, DestinationAssessment } from './types.js';

const plain: DestinationAssessment = { services: [], reasons: [] };

function destination(
  remote: string,
  locality: AssessedDestination['locality'],
  assessment: DestinationAssessment = plain,
): AssessedDestination {
  return {
    remote, scope: locality === 'local' ? 'private' : 'public', country: locality === 'foreign' ? 'US' : null,
    locality, domains: [], ports: [443], kinds: ['syn'], firstSeenMs: 0, lastSeenMs: 1_000, packets: 1,
    owners: [], assessment,
  };
}

const snapshot: NetwatchSnapshot = {
  status: {
    state: 'running', reason: null, pid: 7, startedAtMs: 0, stderrTail: [], publicObserved: 2, publicWithoutCountry: 1,
  },
  homeCountry: 'JP',
  destinations: [
    destination('203.0.113.1', 'foreign', { services: [], reasons: ['direct-ip'] }),
    destination('203.0.113.2', 'unknown'),
    destination('10.0.0.1', 'local'),
    destination('203.0.113.3', 'foreign', { services: ['memoria'], reasons: [] }),
  ],
  unparsedLines: 3,
  attribution: { state: 'running', reason: null, lastRefreshMs: 2_000, attributed: 5, expired: 1, pending: 0 },
};

describe('buildNetwatchRouter', () => {
  const app = buildNetwatchRouter(() => snapshot);

  it('status は状態・国外判定ごとの件数・怪しい件数・送信元の特定状況を返す', async () => {
    const response = await app.request('/api/v1/netwatch/status');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      state: 'running', pid: 7, home_country: 'JP', unparsed_lines: 3,
      destinations: { foreign: 2, domestic: 0, unknown: 1, local: 1 },
      suspicious: 1, service_destinations: 1,
      attribution: { state: 'running', last_refresh_at: '1970-01-01T00:00:02.000Z', attributed: 5, expired: 1, pending: 0 },
    });
  });

  it('destinations は既定でサービスの通信を外し、 locality で絞り、 limit で切る', async () => {
    const foreign = await (await app.request('/api/v1/netwatch/destinations?locality=foreign')).json() as {
      total: number; destinations: Array<{ remote: string; last_seen_at: string; suspicious_reasons: string[] }>;
    };
    expect(foreign.total).toBe(1);
    expect(foreign.destinations[0]).toMatchObject({
      remote: '203.0.113.1', last_seen_at: '1970-01-01T00:00:01.000Z', suspicious_reasons: ['direct-ip'],
    });
    const limited = await (await app.request('/api/v1/netwatch/destinations?limit=1')).json() as { total: number; destinations: unknown[] };
    expect(limited).toMatchObject({ total: 3 });
    expect(limited.destinations).toHaveLength(1);
  });

  it('include_services=true でサービスの通信も含め、 suspicious=true で怪しいものだけにする', async () => {
    const all = await (await app.request('/api/v1/netwatch/destinations?include_services=true')).json() as { total: number };
    expect(all.total).toBe(4);
    const suspicious = await (await app.request('/api/v1/netwatch/destinations?suspicious=true')).json() as {
      total: number; destinations: Array<{ remote: string }>;
    };
    expect(suspicious.total).toBe(1);
    expect(suspicious.destinations[0]?.remote).toBe('203.0.113.1');
  });

  it('不正な locality・limit・真偽値は 400', async () => {
    expect((await app.request('/api/v1/netwatch/destinations?locality=mars')).status).toBe(400);
    expect((await app.request('/api/v1/netwatch/destinations?limit=0')).status).toBe(400);
    expect((await app.request('/api/v1/netwatch/destinations?suspicious=yes')).status).toBe(400);
  });
});
