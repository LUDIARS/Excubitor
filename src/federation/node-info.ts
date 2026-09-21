/**
 * 拠点情報: この拠点の Excubitor の版・起動時刻、 OS、 拠点間リスナー、 登録ピア数、
 * 担保しているサービス数、 更新の取得元。 health 応答に載せて他拠点から確認できるようにする。
 * 表示用で、 認可や判定には使わない。
 */

import os from 'node:os';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { selfReportedVersion } from '../process/service-version.js';
import type { ServiceCoverage } from './coverage.js';
import type { NodeInfo } from './health-types.js';
import type { FederationListenerStatus } from './listener.js';
import type { UpdateSource } from './operations/types.js';
import { getSelfVersion } from './self-version.js';

/** @implements SPEC-FEDERATION-NODE-INFO */

export interface NodeInfoInput {
  node: string;
  version: string;
  git: { branch: string | null; hash: string | null };
  startedAt: number;
  platform: NodeInfo['platform'];
  listener: FederationListenerStatus;
  peers: NodeInfo['peers'];
  coverage: readonly ServiceCoverage[];
  catalogTotal: number;
  updateSource: UpdateSource | null;
}

/** 集めた値から拠点情報を組む (pure)。 */
export function buildNodeInfo(input: NodeInfoInput): NodeInfo {
  const covered = input.coverage.filter((c) => c.covered);
  return {
    node: input.node,
    excubitor: {
      version: input.version,
      git_branch: input.git.branch,
      git_hash: input.git.hash,
      started_at: input.startedAt,
    },
    platform: input.platform,
    listener: { enabled: input.listener.enabled, listening: input.listener.listening, error: input.listener.error },
    peers: input.peers,
    services: {
      catalog_total: input.catalogTotal,
      covered: covered.length,
      managed: covered.filter((c) => c.kind === 'managed').length,
    },
    update_source: input.updateSource,
  };
}

function peerCounts(): NodeInfo['peers'] {
  const row = db().get(sql`
    SELECT COUNT(*) AS registered, COALESCE(SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END), 0) AS enabled
    FROM remote_peers
  `) as { registered: number; enabled: number } | undefined;
  return { registered: Number(row?.registered ?? 0), enabled: Number(row?.enabled ?? 0) };
}

export function localPlatform(): NodeInfo['platform'] {
  return {
    os: process.platform,
    release: os.release(),
    arch: process.arch,
    hostname: os.hostname(),
    node_version: process.version,
  };
}

export interface LocalNodeInfoInput {
  node: string;
  listener: FederationListenerStatus;
  coverage: readonly ServiceCoverage[];
  catalogTotal: number;
  updateSource: UpdateSource | null;
}

/** 本拠点の拠点情報。 版と起動時刻は起動時に控えた値 (self-version.ts)。 */
export function localNodeInfo(input: LocalNodeInfoInput): NodeInfo {
  const self = getSelfVersion();
  return buildNodeInfo({
    ...input,
    version: selfReportedVersion(),
    git: { branch: self?.branch ?? null, hash: self?.hash ?? null },
    startedAt: self?.startedAt ?? Math.round(Date.now() - process.uptime() * 1000),
    platform: localPlatform(),
    peers: peerCounts(),
  });
}
