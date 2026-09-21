/**
 * サービスの直近の状態 (service_instances.state) を読む。
 * 更新適用 (apply.ts) と拠点への依頼 (federation/operations) が「起動中なら再起動する」判定に使う。
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

export function currentState(code: string): string | null {
  const rows = db().all(sql`
    SELECT si.state AS state FROM service_instances si
    JOIN services s ON s.id = si.service_id WHERE s.code = ${code} LIMIT 1
  `) as Array<{ state: string }>;
  return rows[0]?.state ?? null;
}
