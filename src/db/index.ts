import Database from 'better-sqlite3';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { applyMigrations } from './schema.js';

let db: Database.Database | null = null;

export function openDb(path: string): Database.Database {
  if (db) return db;
  mkdirSync(dirname(path), { recursive: true });
  db = new Database(path);
  applyMigrations(db);
  return db;
}

/**
 * Open the existing database without taking migration/write ownership.
 * Worker threads use this so expensive read models cannot block the HTTP event loop.
 */
export function openReadOnlyDb(path: string): Database.Database {
  if (db) return db;
  db = new Database(path, { readonly: true, fileMustExist: true });
  return db;
}

export function currentDb(): Database.Database {
  if (!db) throw new Error('Excubitor DB is not open. Call openDb() first.');
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}


