import os from 'node:os';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

let cachedHostId: string | null = null;

/**
 * Excubitor が動いているマシンの host レコードを upsert して id を返す。
 * v0.1 では同居 agent (server 自身) を 1 つの host として扱う。
 */
export async function getOrCreateLocalHost(): Promise<string> {
  if (cachedHostId) return cachedHostId;

  const hostname = os.hostname();
  const result = await db.execute(sql`
    WITH ins AS (
      INSERT INTO hosts (name, hostname, agent_version, last_heartbeat_at)
      SELECT ${hostname}, ${hostname}, ${'0.1.0-local'}, now()
      WHERE NOT EXISTS (SELECT 1 FROM hosts WHERE hostname = ${hostname})
      RETURNING id
    ),
    upd AS (
      UPDATE hosts
      SET last_heartbeat_at = now(), updated_at = now()
      WHERE hostname = ${hostname}
      RETURNING id
    )
    SELECT id FROM ins
    UNION ALL
    SELECT id FROM upd
    LIMIT 1
  `);

  const arr = result as unknown as Array<{ id: string }>;
  if (arr.length === 0) throw new Error('failed to create host record');
  cachedHostId = arr[0]!.id;
  return cachedHostId;
}

export async function heartbeatLocalHost(): Promise<void> {
  const hostname = os.hostname();
  await db.execute(sql`
    UPDATE hosts SET last_heartbeat_at = now(), updated_at = now()
    WHERE hostname = ${hostname}
  `);
}
