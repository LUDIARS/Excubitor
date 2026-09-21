/**
 * 本拠点の識別名とスナップショット (サマリ + サービス一覧 + host メトリクス)。
 *
 * 値はすべて DB に既にある監視結果を読むだけで、 ここから probe や OS 走査は起こさない。
 * 拠点間 API (node / health) と、 本拠点の集約ビューの self 部分で共用する。
 */

import os from 'node:os';
import { sql as drizzleSql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { summarizeServices, type ServiceStateRow } from '../hub/router.js';

/** 本ノードの名前 (federation 上の識別子)。 env 優先、 既定 hostname。 */
export function localNodeName(): string {
  return process.env.EXCUBITOR_NODE_NAME?.trim() || os.hostname();
}

export interface NodeServiceRow {
  code: string;
  name: string;
  state: string;
  port: number | null;
  git_branch: string | null;
}

export interface NodeSnapshot {
  node: string;
  summary: ReturnType<typeof summarizeServices>;
  services: NodeServiceRow[];
  host: Record<string, unknown> | null;
}

/** 本ノードのスナップショット (リモート公開 + ローカル集約の self 部分で共用)。 */
export function localNodeSnapshot(): NodeSnapshot {
  const stateRows = db().all(drizzleSql`
    SELECT si.state AS state
    FROM services s
    LEFT JOIN service_instances si ON si.service_id = s.id
    WHERE s.is_active = 1
  `) as Array<ServiceStateRow>;
  const errRows = db().all(
    drizzleSql`SELECT COUNT(*) AS n FROM error_tasks WHERE state = 'open'`,
  ) as Array<{ n: number }>;
  const summary = summarizeServices(stateRows, Number(errRows[0]?.n ?? 0));

  const svcRows = db().all(drizzleSql`
    SELECT s.code, s.name, si.state, si.port, si.git_branch
    FROM services s
    LEFT JOIN service_instances si ON si.service_id = s.id
    WHERE s.is_active = 1
    ORDER BY s.code ASC
  `) as Array<Record<string, unknown>>;
  const services = svcRows.map((r) => ({
    code: r.code as string,
    name: r.name as string,
    state: (r.state as string | null) ?? 'unknown',
    port: (r.port as number | null) ?? null,
    git_branch: (r.git_branch as string | null) ?? null,
  }));

  return { node: localNodeName(), summary, services, host: latestHostSample() };
}

function latestHostSample(): Record<string, unknown> | null {
  const hostRows = db().all(drizzleSql`
    SELECT rss_bytes, cpu_pct, detail, sampled_at
    FROM memory_samples WHERE target_kind = 'host'
    ORDER BY sampled_at DESC LIMIT 1
  `) as Array<Record<string, unknown>>;
  const row = hostRows[0];
  if (!row) return null;
  let detail: Record<string, unknown> = {};
  try {
    detail = row.detail ? JSON.parse(row.detail as string) : {};
  } catch {
    // detail は補助情報。 壊れた JSON でも使用量 / CPU は返せるので空として扱う。
  }
  return {
    used_mem_bytes: row.rss_bytes ?? null,
    cpu_pct: row.cpu_pct ?? null,
    sampled_at: Number(row.sampled_at),
    ...detail,
  };
}
