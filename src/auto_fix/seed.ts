/**
 * Seed default error_rules at startup.
 *
 * Existing rule names are left untouched.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createNamedLogger } from '../shared/logger.js';
import { db } from '../db/client.js';

const logger = createNamedLogger('excubitor.auto_fix.seed');

interface DefaultRule {
  name: string;
  pattern: string;
  pattern_type: 'regex' | 'keyword';
  severity: 'info' | 'warn' | 'error' | 'fatal';
  service_codes?: string[];
}

const DEFAULTS: DefaultRule[] = [
  { name: 'Anatomia fatal crash', pattern: '\\[anatomia-crash\\]', pattern_type: 'regex', severity: 'fatal', service_codes: ['anatomia'] },
  { name: 'pnpm ignored builds', pattern: 'ERR_PNPM_IGNORED_BUILDS', pattern_type: 'keyword', severity: 'error' },
  { name: 'pnpm lockfile mismatch', pattern: 'ERR_PNPM_LOCKFILE_CONFIG_MISMATCH', pattern_type: 'keyword', severity: 'error' },
  { name: 'Node module not found', pattern: 'ERR_MODULE_NOT_FOUND', pattern_type: 'keyword', severity: 'error' },
  { name: 'Cannot find module', pattern: 'Cannot find module', pattern_type: 'keyword', severity: 'error' },
  { name: 'TS compile error', pattern: 'error TS\\d{4,}', pattern_type: 'regex', severity: 'error' },
  { name: 'Uncaught exception', pattern: 'Uncaught\\s+(?:Type)?Error', pattern_type: 'regex', severity: 'fatal' },
  { name: 'ECONNREFUSED', pattern: 'ECONNREFUSED', pattern_type: 'keyword', severity: 'warn' },
];

export async function seedDefaultRules(): Promise<void> {
  // Remove rows left by older id-generation bugs.
  db().run(sql`DELETE FROM error_rules WHERE id IS NULL`);
  // Avoid duplicate defaults even when the DB has no unique constraint on name.
  for (const r of DEFAULTS) {
    const serviceCodes = r.service_codes ? JSON.stringify(r.service_codes) : null;
    db().run(sql`
      INSERT INTO error_rules (id, name, pattern, pattern_type, severity, service_codes)
      SELECT ${randomUUID()}, ${r.name}, ${r.pattern}, ${r.pattern_type}, ${r.severity}, ${serviceCodes}
      WHERE NOT EXISTS (SELECT 1 FROM error_rules WHERE name = ${r.name})
    `);
  }
  logger.info({ count: DEFAULTS.length }, 'default error rules seeded');
}
