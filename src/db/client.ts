import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { currentDb } from './index.js';
import * as schema from './schema.js';

let _db: BetterSQLite3Database<typeof schema> | null = null;

export function db(): BetterSQLite3Database<typeof schema> {
  if (!_db) {
    _db = drizzle(currentDb(), { schema });
  }
  return _db;
}

export { schema };


