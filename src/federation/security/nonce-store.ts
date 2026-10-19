import { currentDb } from '../../db/index.js';

/** Durable unique nonce: replay state survives backend restarts. */
export function rememberMeshNonce(subject: string, nonce: string, expiresAt: number, now: number): boolean {
  const database = currentDb();
  return database.transaction(() => {
    database.prepare('DELETE FROM mesh_request_nonces WHERE expires_at <= ?').run(now);
    // Bound authenticated flood storage. Capacity exhaustion denies new requests.
    const row = database.prepare('SELECT COUNT(*) AS count FROM mesh_request_nonces').get() as { count: number };
    if (row.count >= 100_000) return false;
    return database.prepare('INSERT OR IGNORE INTO mesh_request_nonces(subject, nonce, expires_at) VALUES (?, ?, ?)')
      .run(subject, nonce, expiresAt).changes === 1;
  })();
}
