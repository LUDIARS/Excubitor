import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

export const incidentSchema = z.object({
  id: z.string().uuid(), site: z.string(), service: z.string(), reason: z.string(),
  at: z.number(), containment: z.enum(['pending', 'confirmed', 'failed']),
  notification: z.enum(['pending', 'sent']),
  notifiedContainment: z.enum(['pending', 'confirmed', 'failed']).nullable().default(null),
  persistenceFailed: z.boolean().default(false),
});
export type Incident = z.infer<typeof incidentSchema>;

/** Dedicated durable latch. No reset or retention can silently reopen ingress. */
export class IntrusionStore {
  private readonly db: Database.Database;
  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new Database(file);
    try {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = FULL');
      this.db.exec('CREATE TABLE IF NOT EXISTS incident (singleton INTEGER PRIMARY KEY CHECK(singleton=1), payload TEXT NOT NULL)');
      this.db.exec('CREATE TABLE IF NOT EXISTS lifecycle (singleton INTEGER PRIMARY KEY CHECK(singleton=1), running INTEGER NOT NULL)');
      this.db.exec('CREATE TABLE IF NOT EXISTS tunnel_snapshot (tunnel_id TEXT PRIMARY KEY, payload TEXT NOT NULL)');
    } catch (error) { this.db.close(); throw error; }
  }
  read(): Incident | null {
    const row = this.db.prepare('SELECT payload FROM incident WHERE singleton=1').get() as { payload: string } | undefined;
    return row ? incidentSchema.parse(JSON.parse(row.payload)) : null;
  }
  save(incident: Incident): void {
    this.db.prepare('INSERT INTO incident(singleton,payload) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET payload=excluded.payload')
      .run(JSON.stringify(incidentSchema.parse(incident)));
  }
  wasRunning(): boolean {
    const row = this.db.prepare('SELECT running FROM lifecycle WHERE singleton=1').get() as { running: number } | undefined;
    return row?.running === 1;
  }
  saveTunnelSnapshot(id: string, config: unknown): void {
    // First snapshot wins across retries/restarts; never overwrite it with blocked rules.
    this.db.prepare('INSERT OR IGNORE INTO tunnel_snapshot(tunnel_id,payload) VALUES(?,?)').run(id, JSON.stringify(config));
  }
  markRunning(running: boolean): void {
    this.db.prepare('INSERT INTO lifecycle(singleton,running) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET running=excluded.running').run(running ? 1 : 0);
  }
  close(): void { this.db.close(); }
}
