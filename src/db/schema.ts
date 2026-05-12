/**
 * Drizzle schema (query 用)。
 *
 * v0.1 では migrations/001_initial.sql が source of truth。
 * 本 schema.ts はアプリ側で型安全に SELECT / INSERT するための薄い対応。
 */

import {
  pgTable,
  text,
  timestamp,
  integer,
  jsonb,
  boolean,
  uuid,
  bigserial,
} from 'drizzle-orm/pg-core';

export const hosts = pgTable('hosts', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  hostname: text('hostname').notNull(),
  agent_version: text('agent_version'),
  last_heartbeat_at: timestamp('last_heartbeat_at', { withTimezone: true }),
  is_active: boolean('is_active').notNull().default(true),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const services = pgTable('services', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  catalog_snapshot: jsonb('catalog_snapshot').notNull(),
  is_active: boolean('is_active').notNull().default(true),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const serviceInstances = pgTable('service_instances', {
  id: uuid('id').primaryKey().defaultRandom(),
  service_id: uuid('service_id').notNull().references(() => services.id),
  host_id: uuid('host_id').references(() => hosts.id),
  pid: integer('pid'),
  docker_id: text('docker_id'),
  state: text('state').notNull().default('unknown'),
  last_seen_at: timestamp('last_seen_at', { withTimezone: true }),
  started_at: timestamp('started_at', { withTimezone: true }),
  exit_code: integer('exit_code'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const errorRules = pgTable('error_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  pattern: text('pattern').notNull(),
  pattern_type: text('pattern_type').notNull().default('regex'),
  severity: text('severity').notNull().default('error'),
  service_codes: text('service_codes').array(),
  is_active: boolean('is_active').notNull().default(true),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const errorTasks = pgTable('error_tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  rule_id: uuid('rule_id').references(() => errorRules.id),
  service_instance_id: uuid('service_instance_id').references(() => serviceInstances.id),
  severity: text('severity').notNull().default('error'),
  summary: text('summary').notNull(),
  log_excerpt: text('log_excerpt'),
  occurrence_count: integer('occurrence_count').notNull().default(1),
  first_seen_at: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  last_seen_at: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  state: text('state').notNull().default('open'),
  snooze_until: timestamp('snooze_until', { withTimezone: true }),
  triaged_by: text('triaged_by'),
  triaged_at: timestamp('triaged_at', { withTimezone: true }),
  note: text('note'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const auditLog = pgTable('audit_log', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
  actor: text('actor'),
  action: text('action').notNull(),
  target_type: text('target_type'),
  target_id: text('target_id'),
  payload: jsonb('payload'),
});
