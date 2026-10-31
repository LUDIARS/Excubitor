/** @implements SPEC-EX-NETWATCH */
/**
 * 通信監視の読み出し API (`/api/v1/netwatch/*`)。 集計はバックグラウンドで済んでおり、
 * ここではメモリ上の値を返すだけにする (要求のたびにキャプチャや名前解決をしない)。
 *
 * - GET /api/v1/netwatch/status       : キャプチャの状態と件数
 * - GET /api/v1/netwatch/destinations : 通信先の一覧。 ?locality=foreign|domestic|unknown|local、 ?limit=、
 *   ?suspicious=true (怪しいものだけ)、 ?include_services=true (サービスの通信も含める。 既定は外す)
 */

import { Hono } from 'hono';
import type { NetwatchSnapshot } from './runtime.js';
import type { AssessedDestination, Locality } from './types.js';

const LOCALITIES: Locality[] = ['foreign', 'domestic', 'unknown', 'local'];
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 5_000;

function destinationJson(destination: AssessedDestination): Record<string, unknown> {
  return {
    remote: destination.remote,
    scope: destination.scope,
    country: destination.country,
    locality: destination.locality,
    domains: destination.domains,
    ports: destination.ports,
    kinds: destination.kinds,
    first_seen_at: new Date(destination.firstSeenMs).toISOString(),
    last_seen_at: new Date(destination.lastSeenMs).toISOString(),
    packets: destination.packets,
    owners: destination.owners,
    services: destination.assessment.services,
    suspicious_reasons: destination.assessment.reasons,
  };
}

function countByLocality(destinations: AssessedDestination[]): Record<Locality, number> {
  const counts: Record<Locality, number> = { foreign: 0, domestic: 0, unknown: 0, local: 0 };
  for (const destination of destinations) counts[destination.locality] += 1;
  return counts;
}

export function buildNetwatchRouter(readSnapshot: () => NetwatchSnapshot): Hono {
  const app = new Hono();

  app.get('/api/v1/netwatch/status', (c) => {
    const snapshot = readSnapshot();
    const { status } = snapshot;
    return c.json({
      state: status.state,
      reason: status.reason,
      pid: status.pid,
      started_at: status.startedAtMs === null ? null : new Date(status.startedAtMs).toISOString(),
      stderr_tail: status.stderrTail,
      home_country: snapshot.homeCountry,
      public_observed: status.publicObserved,
      public_without_country: status.publicWithoutCountry,
      unparsed_lines: snapshot.unparsedLines,
      destinations: countByLocality(snapshot.destinations),
      suspicious: snapshot.destinations.filter((destination) => destination.assessment.reasons.length > 0).length,
      service_destinations: snapshot.destinations.filter((destination) => destination.assessment.services.length > 0).length,
      attribution: {
        state: snapshot.attribution.state,
        reason: snapshot.attribution.reason,
        last_refresh_at: snapshot.attribution.lastRefreshMs === null
          ? null
          : new Date(snapshot.attribution.lastRefreshMs).toISOString(),
        attributed: snapshot.attribution.attributed,
        expired: snapshot.attribution.expired,
        pending: snapshot.attribution.pending,
      },
    });
  });

  app.get('/api/v1/netwatch/destinations', (c) => {
    const locality = c.req.query('locality');
    if (locality !== undefined && !LOCALITIES.includes(locality as Locality)) {
      return c.json({ error: `locality must be one of ${LOCALITIES.join(', ')}` }, 400);
    }
    const limitParam = c.req.query('limit');
    const limit = limitParam === undefined ? DEFAULT_LIMIT : Number(limitParam);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      return c.json({ error: `limit must be an integer between 1 and ${MAX_LIMIT}` }, 400);
    }
    const flags: Record<string, boolean> = {};
    for (const name of ['suspicious', 'include_services']) {
      const value = c.req.query(name);
      if (value !== undefined && value !== 'true' && value !== 'false') {
        return c.json({ error: `${name} must be true or false` }, 400);
      }
      flags[name] = value === 'true';
    }
    const filtered = readSnapshot().destinations.filter((destination) =>
      (!locality || destination.locality === locality)
      && (flags.include_services || destination.assessment.services.length === 0)
      && (!flags.suspicious || destination.assessment.reasons.length > 0));
    return c.json({
      total: filtered.length,
      destinations: filtered.slice(0, limit).map(destinationJson),
    });
  });

  return app;
}
