/**
 * 襍ｷ蜍墓凾縺ｫ繝・ヵ繧ｩ繝ｫ繝医・ error_rules 繧・seed 縺吶ｋ縲・
 *
 * 譌｢縺ｫ蜷悟錐縺ｮ rule 縺後≠繧後・ DO NOTHING (ON CONFLICT (name))縲・
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
  // id 逕滓・貍上ｌ繝舌げ縺ｧ NULL id 縺ｮ縺ｾ縺ｾ谿九▲縺溯｡後ｒ髯､蜴ｻ
  db().run(sql`DELETE FROM error_rules WHERE id IS NULL`);
  // error_rules.name 縺ｫ unique 蛻ｶ邏・・辟｡縺・′縲・驥崎､・∩縺代ｋ縺溘ａ name 縺ｧ蜈医↓邨槭ｋ
  for (const r of DEFAULTS) {
    db().run(sql`
      INSERT INTO error_rules (id, name, pattern, pattern_type, severity)
      SELECT ${randomUUID()}, ${r.name}, ${r.pattern}, ${r.pattern_type}, ${r.severity}
      WHERE NOT EXISTS (SELECT 1 FROM error_rules WHERE name = ${r.name})
    `);
  }
  logger.info({ count: DEFAULTS.length }, 'default error rules seeded');
}


