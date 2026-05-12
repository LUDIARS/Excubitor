/**
 * error_task が新規 / 復活した時の auto-fix 自動 trigger 判定。
 *
 * - service の catalog.auto_fix.enabled でなければ skip
 * - error_task の auto_fix_attempts >= max_auto_attempts なら **人間判断へ** (state='awaiting_human')
 * - それ以外なら auto_fix_attempts++ して runAutoFix() を非同期に起動
 */
import { sql } from 'drizzle-orm';
import pino from 'pino';
import { db } from '../db/client.js';
import type { Service } from '../catalog/loader.js';
import { runAutoFix } from './runner.js';

const logger = pino({ name: 'excubitor.auto_fix.trigger' });

export async function maybeTriggerAutoFix(args: {
  errorTaskId: string;
  service: Service;
  summary: string;
  logExcerpt: string;
}): Promise<void> {
  const af = args.service.auto_fix;
  if (!af?.enabled) return;

  // 現在の attempts と auto_fix_state を atomic に取得して increment
  const rows = await db.execute(sql`
    UPDATE error_tasks
    SET auto_fix_attempts = auto_fix_attempts + 1, updated_at = now()
    WHERE id = ${args.errorTaskId}::uuid
    RETURNING auto_fix_attempts
  `);
  const attempts = (rows as unknown as Array<{ auto_fix_attempts: number }>)[0]?.auto_fix_attempts ?? 0;

  if (attempts > af.max_auto_attempts) {
    // 上限超過 — 自動 trigger せず人間判断へ
    await db.execute(sql`
      UPDATE error_tasks
      SET auto_fix_state = 'awaiting_human', updated_at = now()
      WHERE id = ${args.errorTaskId}::uuid
    `);
    logger.warn(
      { code: args.service.code, taskId: args.errorTaskId, attempts, max: af.max_auto_attempts },
      'auto-fix limit reached, escalating to human',
    );
    return;
  }

  logger.info(
    { code: args.service.code, taskId: args.errorTaskId, attempts },
    'triggering auto-fix',
  );
  void runAutoFix({
    errorTaskId: args.errorTaskId,
    service: args.service,
    triggeredBy: 'auto',
    summary: args.summary,
    logExcerpt: args.logExcerpt,
  }).catch((err: unknown) =>
    logger.error({ err: (err as Error).message, code: args.service.code }, 'runAutoFix threw'),
  );
}
