import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

let cachedHostId: string | null = null;

/**
 * Upsert the host record for this machine and return its id.
 * The local server is represented by one host record.
 */
export async function getOrCreateLocalHost(): Promise<string> {
  if (cachedHostId) return cachedHostId;

  const hostname = os.hostname();
  // SQLite uses separate statements instead of a data-modifying CTE.
  // Select first; update an existing host or insert a new one.
  const existing = db().get(sql`SELECT id FROM hosts WHERE hostname = ${hostname}`) as { id: string } | undefined;
  if (existing) {
    db().run(sql`
      UPDATE hosts SET last_heartbeat_at = unixepoch() * 1000, updated_at = unixepoch() * 1000
      WHERE hostname = ${hostname}
    `);
    cachedHostId = existing.id;
    return cachedHostId;
  }
  const newId = randomUUID();
  db().run(sql`
    INSERT INTO hosts (id, name, hostname, agent_version, last_heartbeat_at)
    VALUES (${newId}, ${hostname}, ${hostname}, ${'0.1.0-local'}, unixepoch() * 1000)
  `);
  cachedHostId = newId;
  return cachedHostId;
}

export async function heartbeatLocalHost(): Promise<void> {
  const hostname = os.hostname();
  db().run(sql`
    UPDATE hosts SET last_heartbeat_at = unixepoch() * 1000, updated_at = unixepoch() * 1000
    WHERE hostname = ${hostname}
  `);
}


