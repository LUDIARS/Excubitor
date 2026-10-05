/**
 * 拠点ごとの自動起動の上書き。
 *
 * catalog は git で全拠点に共有されるため、「この拠点では起動時に立ち上げる / 立ち上げない」は
 * catalog に書けない (例: Cernere は GROMAC でだけ常駐させ、本社では起動しない)。
 * 優先順位: service_prefs.autostart (拠点の DB 上書き) → catalog の autostart → false。
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { Service } from '../catalog/loader.js';

/** DB の上書きを code→autostart で取得する (未設定 code は欠落)。 */
export function readAutostartPrefs(): Map<string, boolean> {
  const rows = db().all(sql`
    SELECT code, autostart FROM service_prefs WHERE autostart IS NOT NULL
  `) as Array<{ code: string; autostart: number }>;
  return new Map(rows.map((r) => [r.code, r.autostart === 1]));
}

/** 1 サービスの実効 autostart (pure)。 */
export function effectiveAutostart(svc: Pick<Service, 'code' | 'autostart'>, prefs: Map<string, boolean>): boolean {
  return prefs.get(svc.code) ?? svc.autostart ?? false;
}

/** 上書きを保存する (null で catalog の値に戻す)。 */
export function setAutostartPref(code: string, autostart: boolean | null): void {
  if (autostart === null) {
    db().run(sql`UPDATE service_prefs SET autostart = NULL, updated_at = unixepoch() * 1000 WHERE code = ${code}`);
    return;
  }
  db().run(sql`
    INSERT INTO service_prefs (code, autostart, updated_at)
    VALUES (${code}, ${autostart ? 1 : 0}, unixepoch() * 1000)
    ON CONFLICT(code) DO UPDATE SET autostart = excluded.autostart, updated_at = excluded.updated_at
  `);
}
