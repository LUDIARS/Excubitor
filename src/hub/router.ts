/**
 * Corpus multi-hub backend (`/api/hub/*`)。
 *
 * Corpus (大規模 Hub) は `ServiceConnector` でサービスの multi-hub backend を
 * HTTP で叩く (Corpus DESIGN §4)。Excubitor はここで Corpus 向けに「運用コアの
 * サマリ」を flat JSON で公開する。宣言的レンダリング側 (Corpus) が読みやすい
 * 平坦な形にする (設計書 §7.2)。
 *
 * 起動/再起動の操作は既存の `/api/v1/services/:code/control` をそのまま使う
 * (Corpus connector は任意 path を fetch できるため hub 側に重複定義しない)。
 */

import { Hono } from 'hono';
import { sql as drizzleSql } from 'drizzle-orm';
import { db } from '../db/client.js';

export interface ServiceStateRow {
  state?: string | null;
}

export interface HubSummary {
  service: 'excubitor';
  services_total: number;
  /** state === 'running' の数。 */
  up: number;
  /** state が running / unknown 以外 (stopped / exited / error 等)。 */
  down: number;
  /** instance 未観測 (state 無し or 'unknown')。 */
  unknown: number;
  /** open な error_tasks の件数。 */
  open_errors: number;
}

/**
 * pure: service の state 行 + open error 件数 → Hub カード用の flat サマリ。
 * DB に依存しないので単体テスト可能。
 */
export function summarizeServices(rows: ServiceStateRow[], openErrors: number): HubSummary {
  let up = 0;
  let down = 0;
  let unknown = 0;
  for (const r of rows) {
    const s = r.state ?? 'unknown';
    if (s === 'running') up += 1;
    else if (s === 'unknown') unknown += 1;
    else down += 1;
  }
  return {
    service: 'excubitor',
    services_total: rows.length,
    up,
    down,
    unknown,
    open_errors: openErrors,
  };
}

export function buildHubRouter(): Hono {
  const app = new Hono();

  // connector の health probe 用 (Corpus HttpServiceConnector の healthPath)。
  app.get('/api/hub/health', (c) => c.json({ status: 'up', service: 'excubitor' }));

  // Hub カード用のサマリ (flat)。
  app.get('/api/hub/summary', (c) => {
    const rows = db().all(drizzleSql`
      SELECT si.state AS state
      FROM services s
      LEFT JOIN service_instances si ON si.service_id = s.id
      WHERE s.is_active = 1
    `) as Array<ServiceStateRow>;
    const errRows = db().all(
      drizzleSql`SELECT COUNT(*) AS n FROM error_tasks WHERE state = 'open'`,
    ) as Array<{ n: number }>;
    const openErrors = Number(errRows[0]?.n ?? 0);
    return c.json(summarizeServices(rows, openErrors));
  });

  // サービス一覧 (slim)。
  app.get('/api/hub/services', (c) => {
    const rows = db().all(drizzleSql`
      SELECT s.code, s.name, si.state, si.port
      FROM services s
      LEFT JOIN service_instances si ON si.service_id = s.id
      WHERE s.is_active = 1
      ORDER BY s.code ASC
    `) as Array<Record<string, unknown>>;
    return c.json({
      services: rows.map((r) => ({
        code: r.code,
        name: r.name,
        state: r.state ?? 'unknown',
        port: r.port ?? null,
      })),
    });
  });

  // open な error_tasks。
  app.get('/api/hub/errors', (c) => {
    const rows = db().all(drizzleSql`
      SELECT et.id, et.severity, et.summary, et.last_seen_at, s.code AS service_code
      FROM error_tasks et
      LEFT JOIN service_instances si ON si.id = et.service_instance_id
      LEFT JOIN services s ON s.id = si.service_id
      WHERE et.state = 'open'
      ORDER BY et.last_seen_at DESC
      LIMIT 100
    `);
    return c.json({ errors: rows });
  });

  return app;
}
