/**
 * Observability (Excubitor 逕ｱ譚･) 縺ｮ Drizzle SQLite 繧ｹ繧ｭ繝ｼ繝・
 *
 * 迚ｩ逅・せ繧ｭ繝ｼ繝櫁・菴薙・ src/db/schema.ts 縺ｮ applyMigrations() 縺ｧ謚募・縺輔ｌ繧・
 * 譛ｬ繝輔ぃ繧､繝ｫ縺ｯ drizzle-orm 邨檎罰縺ｧ蝙句ｮ牙・縺ｫ SELECT/INSERT/UPDATE 縺吶ｋ縺溘ａ縺ｮ蝙句ｮ夂ｾｩ.
 *
 * 蜈・Excubitor 縺ｯ drizzle-orm/pg-core + Postgres. SQLite 蛹悶↓莨ｴ縺・ｻ･荳九ｒ螟画鋤:
 *   - UUID         竊・text PK + app 蛛ｴ crypto.randomUUID()
 *   - JSONB        竊・text (JSON string)
 *   - BOOLEAN      竊・integer({ mode: 'boolean' })
 *   - TIMESTAMPTZ  竊・integer({ mode: 'timestamp_ms' })
 *   - TEXT[]       竊・text (JSON array)
 *   - BIGSERIAL    竊・integer PK AUTOINCREMENT
 */

import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { randomUUID } from 'node:crypto';

export const hosts = sqliteTable('hosts', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  name: text('name').notNull(),
  hostname: text('hostname').notNull(),
  agent_version: text('agent_version'),
  last_heartbeat_at: integer('last_heartbeat_at', { mode: 'timestamp_ms' }),
  is_active: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  updated_at: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
});

export const services = sqliteTable('services', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  catalog_snapshot: text('catalog_snapshot', { mode: 'json' }).notNull(),
  is_active: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  updated_at: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
});

export const serviceInstances = sqliteTable('service_instances', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  service_id: text('service_id').notNull().references(() => services.id),
  host_id: text('host_id').references(() => hosts.id),
  pid: integer('pid'),
  docker_id: text('docker_id'),
  state: text('state').notNull().default('unknown'),
  last_seen_at: integer('last_seen_at', { mode: 'timestamp_ms' }),
  started_at: integer('started_at', { mode: 'timestamp_ms' }),
  exit_code: integer('exit_code'),
  git_branch: text('git_branch'),
  git_hash: text('git_hash'),
  git_dirty: integer('git_dirty', { mode: 'boolean' }),
  package_version: text('package_version'),
  port: integer('port'),
  extra: text('extra', { mode: 'json' }),
  created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  updated_at: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
});

export const livenessHistory = sqliteTable('liveness_history', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  service_instance_id: text('service_instance_id').notNull().references(() => serviceInstances.id),
  probed_at: integer('probed_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  ok: integer('ok', { mode: 'boolean' }).notNull(),
  latency_ms: integer('latency_ms'),
  detail: text('detail', { mode: 'json' }),
});

// Excubitor 縺ｮ process_logs 繧・rename. Concordia 縺ｮ processes (managed processes)
// 逕ｱ譚･縺ｮ process_logs 縺ｨ蛻･迚ｩ.
export const serviceInstanceLogs = sqliteTable('service_instance_logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  service_instance_id: text('service_instance_id').notNull().references(() => serviceInstances.id),
  ts: integer('ts', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  level: text('level'),
  line: text('line').notNull(),
});

export const errorRules = sqliteTable('error_rules', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  name: text('name').notNull(),
  pattern: text('pattern').notNull(),
  pattern_type: text('pattern_type').notNull().default('regex'),
  severity: text('severity').notNull().default('error'),
  // 蜈・TEXT[]. JSON 驟榊・譁・ｭ怜・縺ｧ謖√▽. 繧｢繝励Μ蛛ｴ縺ｧ JSON.parse/stringify.
  service_codes: text('service_codes', { mode: 'json' }),
  is_active: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  updated_at: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
});

export const errorTasks = sqliteTable('error_tasks', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  rule_id: text('rule_id').references(() => errorRules.id),
  service_instance_id: text('service_instance_id').references(() => serviceInstances.id),
  severity: text('severity').notNull().default('error'),
  summary: text('summary').notNull(),
  log_excerpt: text('log_excerpt'),
  occurrence_count: integer('occurrence_count').notNull().default(1),
  first_seen_at: integer('first_seen_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  last_seen_at: integer('last_seen_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  state: text('state').notNull().default('open'),
  snooze_until: integer('snooze_until', { mode: 'timestamp_ms' }),
  triaged_by: text('triaged_by'),
  triaged_at: integer('triaged_at', { mode: 'timestamp_ms' }),
  note: text('note'),
  auto_fix_state: text('auto_fix_state'),
  auto_fix_attempts: integer('auto_fix_attempts').notNull().default(0),
  auto_fix_run_id: text('auto_fix_run_id'),
  created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  updated_at: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
});

export const autoFixRuns = sqliteTable('auto_fix_runs', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  error_task_id: text('error_task_id').notNull().references(() => errorTasks.id),
  service_code: text('service_code').notNull(),
  agent: text('agent').notNull().default('claude-code'),
  state: text('state').notNull().default('pending'),
  triggered_by: text('triggered_by'),
  prompt: text('prompt'),
  started_at: integer('started_at', { mode: 'timestamp_ms' }),
  finished_at: integer('finished_at', { mode: 'timestamp_ms' }),
  exit_code: integer('exit_code'),
  stdout_tail: text('stdout_tail'),
  stderr_tail: text('stderr_tail'),
  branch: text('branch'),
  commit_hash: text('commit_hash'),
  pr_url: text('pr_url'),
  verify_result: text('verify_result'),
  error_message: text('error_message'),
  action_type: text('action_type').notNull().default('fix'),
  created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
});

export const auditLog = sqliteTable('audit_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ts: integer('ts', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  actor: text('actor'),
  action: text('action').notNull(),
  target_type: text('target_type'),
  target_id: text('target_id'),
  payload: text('payload', { mode: 'json' }),
});

import type Database from 'better-sqlite3';

const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS hosts (id TEXT PRIMARY KEY, name TEXT NOT NULL, hostname TEXT NOT NULL, agent_version TEXT, last_heartbeat_at INTEGER, is_active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS services (id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, catalog_snapshot TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS service_instances (id TEXT PRIMARY KEY, service_id TEXT NOT NULL REFERENCES services(id), host_id TEXT REFERENCES hosts(id), pid INTEGER, docker_id TEXT, state TEXT NOT NULL DEFAULT 'unknown', last_seen_at INTEGER, started_at INTEGER, exit_code INTEGER, git_branch TEXT, git_hash TEXT, git_dirty INTEGER, package_version TEXT, port INTEGER, extra TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS service_instance_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, service_instance_id TEXT NOT NULL REFERENCES service_instances(id), ts INTEGER NOT NULL, level TEXT, line TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS error_rules (id TEXT PRIMARY KEY, name TEXT NOT NULL, pattern TEXT NOT NULL, pattern_type TEXT NOT NULL DEFAULT 'regex', severity TEXT NOT NULL DEFAULT 'error', service_codes TEXT, is_active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS error_tasks (id TEXT PRIMARY KEY, rule_id TEXT REFERENCES error_rules(id), service_instance_id TEXT REFERENCES service_instances(id), severity TEXT NOT NULL DEFAULT 'error', summary TEXT NOT NULL, log_excerpt TEXT, occurrence_count INTEGER NOT NULL DEFAULT 1, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'open', snooze_until INTEGER, triaged_by TEXT, triaged_at INTEGER, note TEXT, auto_fix_state TEXT, auto_fix_attempts INTEGER NOT NULL DEFAULT 0, auto_fix_run_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS auto_fix_runs (id TEXT PRIMARY KEY, error_task_id TEXT NOT NULL REFERENCES error_tasks(id), service_code TEXT NOT NULL, agent TEXT NOT NULL DEFAULT 'claude-code', state TEXT NOT NULL DEFAULT 'pending', triggered_by TEXT, prompt TEXT, started_at INTEGER, finished_at INTEGER, exit_code INTEGER, stdout_tail TEXT, stderr_tail TEXT, branch TEXT, commit_hash TEXT, pr_url TEXT, verify_result TEXT, error_message TEXT, action_type TEXT NOT NULL DEFAULT 'fix', created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, actor TEXT, action TEXT NOT NULL, target_type TEXT, target_id TEXT, payload TEXT)`
];

export function applyMigrations(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const tx = db.transaction(() => {
    for (const stmt of MIGRATIONS) db.exec(stmt);
  });
  tx();
}


