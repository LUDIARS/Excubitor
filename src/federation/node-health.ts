/**
 * 本拠点の health 応答 (`GET /api/v1/federation/health`) を組み立てる。
 *
 * 中身はすべてキャッシュ済みの値: 死活は監視ループの health キャッシュ、 他拠点との
 * つながりは peer-poller のキャッシュ、 サービス状態・依頼の履歴は DB、 拠点情報は起動時に
 * 控えた値。 この関数は probe も他拠点への通信も起こさないので、 何拠点から何度呼ばれても
 * 監視対象への負荷は増えない。
 */

import type { Catalog } from '../catalog/loader.js';
import { getHealthCache, type HealthCacheSnapshot } from '../scanner/health-cache.js';
import { resolveCoverage, type ServiceCoverage } from './coverage.js';
import { readCoveragePrefs } from './coverage-prefs.js';
import { localNodeSnapshot, type NodeSnapshot } from './node-snapshot.js';
import { getPeerState, pendingPeerState, toPeerLink } from './peer-cache.js';
import { listEnabledPeerIdentities } from './store.js';
import {
  FEDERATION_HEALTH_SCHEMA,
  type NodeHealthPayload,
  type NodeInfo,
  type NodePeerLink,
  type NodeServiceHealth,
  type ServiceHealthState,
} from './health-types.js';
import type { FederationListenerStatus } from './listener.js';
import { localNodeInfo } from './node-info.js';
import { listRecentOperations, toSummary } from './operations/store.js';
import type { OperationSummary } from './operations/types.js';
import { resolveUpdateSource } from './operations/update-source.js';

/** health 応答に載せる依頼の件数 (新しい順)。 */
export const RECENT_OPERATIONS_IN_HEALTH = 20;

/** @implements SPEC-FEDERATION-HEALTH-CACHE */

export interface HealthPayloadInput {
  now: number;
  snapshot: NodeSnapshot;
  coverage: readonly ServiceCoverage[];
  cache: HealthCacheSnapshot;
  links: NodePeerLink[];
  nodeInfo: NodeInfo;
  operations: OperationSummary[];
}

/** 集めた値から health 応答を組む (pure)。 */
export function buildHealthPayload(input: HealthPayloadInput): NodeHealthPayload {
  const rows = new Map(input.snapshot.services.map((row) => [row.code, row]));
  const services: NodeServiceHealth[] = input.coverage.map((entry) => {
    const row = rows.get(entry.code);
    const cached = input.cache.services.get(entry.code);
    return {
      ...entry,
      state: row?.state ?? 'unknown',
      port: row?.port ?? null,
      git_branch: row?.git_branch ?? null,
      health: {
        state: healthState(cached),
        reason: cached?.reason ?? null,
        detail: cached?.detail ?? null,
        checked_at: cached?.checkedAt ?? null,
        reported_version: cached?.reportedVersion ?? null,
      },
    };
  });
  return {
    schema: FEDERATION_HEALTH_SCHEMA,
    node: input.snapshot.node,
    generated_at: input.now,
    scan: {
      started_at: input.cache.startedAt,
      completed_at: input.cache.completedAt,
      duration_ms: input.cache.durationMs,
      interval_ms: input.cache.intervalMs,
    },
    summary: input.snapshot.summary,
    host: input.snapshot.host,
    services,
    links: input.links,
    node_info: input.nodeInfo,
    operations: input.operations,
  };
}

function healthState(cached: { ok: boolean; reason: string } | undefined): ServiceHealthState {
  if (!cached) return 'unknown';
  if (cached.reason === 'not_configured') return 'unmonitored';
  return cached.ok ? 'up' : 'down';
}

/** 自拠点から有効な各ピアへのつながり (peer-poller のキャッシュ)。 */
export function localPeerLinks(): NodePeerLink[] {
  return listEnabledPeerIdentities().map((peer) => toPeerLink(getPeerState(peer.id) ?? pendingPeerState(peer)));
}

/** 本拠点の health 応答を組む。 listener は拠点間リスナーの今の状態 (拠点情報に出す)。 */
export function localHealthPayload(
  catalog: Catalog,
  listener: FederationListenerStatus,
  now = Date.now(),
): NodeHealthPayload {
  const snapshot = localNodeSnapshot();
  const coverage = resolveCoverage(catalog.services, readCoveragePrefs());
  return buildHealthPayload({
    now,
    snapshot,
    coverage,
    cache: getHealthCache(),
    links: localPeerLinks(),
    nodeInfo: localNodeInfo({
      node: snapshot.node,
      listener,
      coverage,
      catalogTotal: catalog.services.length,
      updateSource: resolveUpdateSource(),
    }),
    operations: listRecentOperations(RECENT_OPERATIONS_IN_HEALTH).map(toSummary),
  });
}
