import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { Catalog } from '../catalog/loader.js';
import { createNamedLogger } from '../shared/logger.js';
import { serviceHealthResults, type ServiceHealthResult } from './health.js';

const logger = createNamedLogger('excubitor.health-state');

/** catalog の monitor.liveness_heartbeat_sec が無いときの既定 (秒)。 */
export const DEFAULT_LIVENESS_HEARTBEAT_SEC = 300;

export interface HealthStateSyncResult {
  checked: number;
  running: string[];
  stopped: string[];
  observations: HealthObservation[];
  /** probe の生結果 (not_configured を含む)。 health キャッシュへ載せる元。 */
  results: ReadonlyMap<string, ServiceHealthResult>;
}

export interface HealthObservation {
  code: string;
  name: string;
  ok: boolean;
  reason: ServiceHealthResult['reason'];
  detail: string | null;
}

export interface HealthStateSyncOptions {
  now?: () => number;
  /** 状態が変わらなくても死活履歴へ 1 行残す間隔 (ms)。 */
  livenessHeartbeatMs?: number;
}

export async function syncHealthyServiceStates(
  catalog: Catalog,
  options: HealthStateSyncOptions = {},
): Promise<HealthStateSyncResult> {
  const results = await serviceHealthResults(catalog);
  const now = (options.now ?? Date.now)();
  const heartbeatMs = options.livenessHeartbeatMs
    ?? (catalog.monitor?.liveness_heartbeat_sec ?? DEFAULT_LIVENESS_HEARTBEAT_SEC) * 1000;
  const running: string[] = [];
  const stopped: string[] = [];
  const observations: HealthObservation[] = [];
  for (const svc of catalog.services) {
    const result = results.get(svc.code);
    if (!result) continue;
    if (result.reason === 'not_configured') continue;
    observations.push({
      code: svc.code,
      name: svc.name,
      ok: result.ok,
      reason: result.reason,
      detail: result.detail ?? null,
    });
    if (result.ok) running.push(svc.code);
    else stopped.push(svc.code);
  }
  // 1 周分の書き込みを 1 トランザクションにまとめる (サービス数ぶんの個別 commit / fsync を避ける)。
  const changed: string[] = [];
  db().transaction(() => {
    for (const observation of observations) {
      const transition = markServiceHealth(observation.code, results.get(observation.code)!, now, heartbeatMs);
      if (transition) changed.push(`${observation.code}:${observation.ok ? 'up' : 'down'}`);
    }
  });
  // 周期が短いので毎周の全件ログは出さない。 状態が変わったときだけ info で残す。
  if (changed.length > 0) logger.info({ changed }, 'health scan observed state changes');
  logger.debug({ running: running.length, stopped: stopped.length }, 'health scan complete');
  return { checked: catalog.services.length, running, stopped, observations, results };
}

/** 1 サービスの死活を書く。 直前の履歴から状態が変わっていれば true。 */
function markServiceHealth(code: string, result: ServiceHealthResult, now: number, heartbeatMs: number): boolean {
  const state = result.ok ? 'running' : 'stopped';
  db().run(sql`
    INSERT INTO service_instances (id, service_id, state, created_at, updated_at)
    SELECT lower(hex(randomblob(16))), s.id, 'pending', ${now}, ${now}
    FROM services s
    WHERE s.code = ${code}
      AND NOT EXISTS (SELECT 1 FROM service_instances si WHERE si.service_id = s.id)
  `);

  db().run(sql`
    UPDATE service_instances
    SET state = ${state},
        last_seen_at = CASE WHEN ${result.ok ? 1 : 0} = 1 THEN ${now} ELSE last_seen_at END,
        reported_version = ${result.reportedVersion ?? null},
        updated_at = ${now}
    WHERE service_id IN (SELECT id FROM services WHERE code = ${code})
  `);

  const instance = db().get(sql`
    SELECT si.id AS id
    FROM service_instances si
    JOIN services s ON s.id = si.service_id
    WHERE s.code = ${code}
    LIMIT 1
  `) as { id: string } | undefined;
  if (!instance) return false;
  const latest = readLatestLiveness(instance.id);
  const transition = latest !== null && latest.ok !== result.ok;
  if (!shouldRecordLiveness(latest, result.ok, now, heartbeatMs)) return false;
  db().run(sql`
    INSERT INTO liveness_history (service_instance_id, probed_at, ok, detail)
    VALUES (
      ${instance.id}, ${now}, ${result.ok ? 1 : 0},
      ${JSON.stringify({ source: 'health', reason: result.reason, detail: result.detail ?? null })}
    )
  `);
  return transition;
}

export interface LatestLiveness {
  ok: boolean;
  probedAt: number;
}

function readLatestLiveness(instanceId: string): LatestLiveness | null {
  const row = db().get(sql`
    SELECT ok, probed_at FROM liveness_history
    WHERE service_instance_id = ${instanceId}
    ORDER BY probed_at DESC, id DESC
    LIMIT 1
  `) as { ok: number; probed_at: number } | undefined;
  return row ? { ok: Number(row.ok) === 1, probedAt: Number(row.probed_at) } : null;
}

/**
 * 死活履歴へ行を足すかを決める (pure)。
 *
 * 死活確認は短い周期で回るので、 毎回 1 行ずつ書くと履歴がサービス数 × 周期で膨らむ。
 * 稼働率の集計 (scanner/downtime.ts) は「状態が変わった時刻」があれば正しく出るので、
 * 状態が変わったときと、 変わらなくても heartbeat 間隔が過ぎたときだけ書く。
 * heartbeat は「最後に確認できた時刻」 の粒度を以前の 5 分走査と同じに保つため。
 */
export function shouldRecordLiveness(
  latest: LatestLiveness | null,
  ok: boolean,
  now: number,
  heartbeatMs: number,
): boolean {
  if (!latest) return true;
  if (latest.ok !== ok) return true;
  return now - latest.probedAt >= heartbeatMs;
}
