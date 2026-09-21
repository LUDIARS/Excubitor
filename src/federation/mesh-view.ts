/**
 * 拠点メッシュの集約ビューを組む (pure)。
 *
 * 入力は自拠点の health 応答と、 peer-poller がキャッシュした各ピアの health 応答だけ。
 * そこから次の 3 つを作る:
 *   - nodes:    拠点ごとの到達性・鮮度・担保数
 *   - links:    拠点 → 拠点のつながり (自拠点の観測 + 各ピアが報告した観測)。
 *               メッシュなので A→B と B→A は別々に見る (片方向だけ切れていることがある)
 *   - coverage: サービスごとに「どの拠点が担保しているか」と、 その死活
 *               - duplicate_managed: 2 拠点以上が起動まで引き受けている (取り合い)
 *               - uncovered:         どこかの catalog に載っているのに、 どの拠点も担保していない
 *               - down:              担保している拠点のどこからも up が見えていない
 */

import type { NodeHealthPayload, NodeInfo, NodePeerLink, PeerLinkStatus, ServiceHealthState } from './health-types.js';
import type { PeerPollState } from './peer-cache.js';
import type { OperationSummary } from './operations/types.js';

/** @implements SPEC-FEDERATION-COVERAGE */

export interface MeshNode {
  node: string;
  peer_id: string | null;
  is_self: boolean;
  status: PeerLinkStatus;
  /** payload が stale_after より古い (または一度も取れていない)。 */
  stale: boolean;
  checked_at: number | null;
  last_ok_at: number | null;
  latency_ms: number | null;
  error: string | null;
  /** 相手の監視ループが最後に 1 周を終えた時刻。 */
  scan_completed_at: number | null;
  services_total: number;
  covered_total: number;
  covered_down: number;
  /** 拠点情報 (相手から取れていなければ null)。 */
  node_info: NodeInfo | null;
  /** マシン全体の CPU / メモリ (監視ループの直近サンプル)。 */
  host: Record<string, unknown> | null;
  /** その拠点が受けた依頼の直近分。 */
  operations: OperationSummary[];
}

export interface MeshLink extends NodePeerLink {
  from: string;
  /** この観測を報告した拠点 (自拠点の観測なら自拠点名)。 */
  reported_by: string;
  /** 報告元の payload が stale。 */
  stale: boolean;
}

export type CoverageIssue = 'duplicate_managed' | 'uncovered' | 'down';

export interface MeshCoverageEntry {
  node: string;
  kind: 'managed' | 'observed';
  covered: boolean;
  source: 'catalog' | 'override';
  health: ServiceHealthState;
  checked_at: number | null;
  stale: boolean;
}

export interface MeshCoverageRow {
  code: string;
  name: string;
  project_code: string | null;
  nodes: MeshCoverageEntry[];
  /** covered かつ managed の拠点。 */
  managed_by: string[];
  issues: CoverageIssue[];
}

export interface MeshView {
  generated_at: number;
  self: string;
  stale_after_ms: number;
  nodes: MeshNode[];
  links: MeshLink[];
  coverage: MeshCoverageRow[];
}

export interface MeshViewInput {
  now: number;
  staleAfterMs: number;
  self: NodeHealthPayload;
  peers: readonly PeerPollState[];
}

interface NodeSource {
  payload: NodeHealthPayload | null;
  stale: boolean;
}

export function buildMeshView(input: MeshViewInput): MeshView {
  const selfName = input.self.node;
  const sources: NodeSource[] = [{ payload: input.self, stale: false }];
  const nodes: MeshNode[] = [selfNode(input.self)];

  for (const peer of input.peers) {
    const stale = peer.payload_received_at == null || input.now - peer.payload_received_at > input.staleAfterMs;
    sources.push({ payload: peer.payload, stale });
    nodes.push(peerNode(peer, stale));
  }

  return {
    generated_at: input.now,
    self: selfName,
    stale_after_ms: input.staleAfterMs,
    nodes,
    links: buildLinks(sources),
    coverage: buildCoverage(sources),
  };
}

function selfNode(self: NodeHealthPayload): MeshNode {
  const counts = coverageCounts(self);
  return {
    node: self.node,
    peer_id: null,
    is_self: true,
    status: 'up',
    stale: false,
    checked_at: self.generated_at,
    last_ok_at: self.generated_at,
    latency_ms: null,
    error: null,
    scan_completed_at: self.scan.completed_at,
    ...counts,
    node_info: self.node_info,
    host: self.host,
    operations: self.operations,
  };
}

function peerNode(peer: PeerPollState, stale: boolean): MeshNode {
  const counts = peer.payload ? coverageCounts(peer.payload) : { services_total: 0, covered_total: 0, covered_down: 0 };
  return {
    node: peer.payload?.node ?? peer.name,
    peer_id: peer.peer_id,
    is_self: false,
    status: peer.status,
    stale,
    checked_at: peer.checked_at,
    last_ok_at: peer.last_ok_at,
    latency_ms: peer.latency_ms,
    error: peer.error,
    scan_completed_at: peer.payload?.scan.completed_at ?? null,
    ...counts,
    node_info: peer.payload?.node_info ?? null,
    host: peer.payload?.host ?? null,
    operations: peer.payload?.operations ?? [],
  };
}

function coverageCounts(payload: NodeHealthPayload): Pick<MeshNode, 'services_total' | 'covered_total' | 'covered_down'> {
  const covered = payload.services.filter((svc) => svc.covered);
  return {
    services_total: payload.services.length,
    covered_total: covered.length,
    covered_down: covered.filter((svc) => svc.health.state === 'down').length,
  };
}

function buildLinks(sources: readonly NodeSource[]): MeshLink[] {
  const links: MeshLink[] = [];
  for (const source of sources) {
    if (!source.payload) continue;
    for (const link of source.payload.links) {
      links.push({ ...link, from: source.payload.node, reported_by: source.payload.node, stale: source.stale });
    }
  }
  return links.sort((a, b) => a.from.localeCompare(b.from) || a.node.localeCompare(b.node));
}

function buildCoverage(sources: readonly NodeSource[]): MeshCoverageRow[] {
  const rows = new Map<string, MeshCoverageRow>();
  for (const source of sources) {
    if (!source.payload) continue;
    for (const svc of source.payload.services) {
      const row = rows.get(svc.code) ?? {
        code: svc.code,
        name: svc.name,
        project_code: svc.project_code,
        nodes: [],
        managed_by: [],
        issues: [],
      };
      row.nodes.push({
        node: source.payload.node,
        kind: svc.kind,
        covered: svc.covered,
        source: svc.source,
        health: svc.health.state,
        checked_at: svc.health.checked_at,
        stale: source.stale,
      });
      rows.set(svc.code, row);
    }
  }
  for (const row of rows.values()) {
    row.managed_by = row.nodes.filter((n) => n.covered && n.kind === 'managed').map((n) => n.node);
    row.issues = coverageIssues(row);
  }
  return [...rows.values()].sort((a, b) => a.code.localeCompare(b.code));
}

export function coverageIssues(row: Pick<MeshCoverageRow, 'nodes' | 'managed_by'>): CoverageIssue[] {
  const issues: CoverageIssue[] = [];
  if (row.managed_by.length >= 2) issues.push('duplicate_managed');
  const covering = row.nodes.filter((n) => n.covered);
  if (covering.length === 0) {
    issues.push('uncovered');
    return issues;
  }
  const anyUp = covering.some((n) => n.health === 'up');
  const anyDown = covering.some((n) => n.health === 'down');
  if (!anyUp && anyDown) issues.push('down');
  return issues;
}
