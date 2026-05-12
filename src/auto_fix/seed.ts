/**
 * 起動時にデフォルトの error_rules を seed する。
 *
 * 既に同名の rule があれば DO NOTHING (ON CONFLICT (name))。
 */
import { sql } from 'drizzle-orm';
import pino from 'pino';
import { db } from '../db/client.js';

const logger = pino({ name: 'excubitor.auto_fix.seed' });

interface DefaultRule {
  name: string;
  pattern: string;
  pattern_type: 'regex' | 'keyword';
  severity: 'info' | 'warn' | 'error' | 'fatal';
}

const DEFAULTS: DefaultRule[] = [
  { name: 'pnpm ignored builds', pattern: 'ERR_PNPM_IGNORED_BUILDS', pattern_type: 'keyword', severity: 'error' },
  { name: 'pnpm lockfile mismatch', pattern: 'ERR_PNPM_LOCKFILE_CONFIG_MISMATCH', pattern_type: 'keyword', severity: 'error' },
  { name: 'Node module not found', pattern: 'ERR_MODULE_NOT_FOUND', pattern_type: 'keyword', severity: 'error' },
  { name: 'Cannot find module', pattern: 'Cannot find module', pattern_type: 'keyword', severity: 'error' },
  { name: 'TS compile error', pattern: 'error TS\\d{4,}', pattern_type: 'regex', severity: 'error' },
  { name: 'Uncaught exception', pattern: 'Uncaught\\s+(?:Type)?Error', pattern_type: 'regex', severity: 'fatal' },
  { name: 'ECONNREFUSED', pattern: 'ECONNREFUSED', pattern_type: 'keyword', severity: 'warn' },
];

export async function seedDefaultRules(): Promise<void> {
  // error_rules.name に unique 制約は無いが、 重複避けるため name で先に絞る
  for (const r of DEFAULTS) {
    await db.execute(sql`
      INSERT INTO error_rules (name, pattern, pattern_type, severity)
      SELECT ${r.name}, ${r.pattern}, ${r.pattern_type}, ${r.severity}
      WHERE NOT EXISTS (SELECT 1 FROM error_rules WHERE name = ${r.name})
    `);
  }
  logger.info({ count: DEFAULTS.length }, 'default error rules seeded');
}
