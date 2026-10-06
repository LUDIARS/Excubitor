/** @implements SPEC-EX-DAILY-SITE-DEPLOY */
import { hostname } from 'node:os';
import { currentDb } from '../../db/index.js';
import { getDiscordNotificationConfig } from '../../secrets/config-store.js';
import { sendDiscordWebhook } from '../../notify/discord-webhook.js';
import { createNamedLogger } from '../../shared/logger.js';
import { saveDailyRun } from './store.js';
import type { DailyRun } from './types.js';

const logger = createNamedLogger('excubitor.daily-update');
export async function notifyDailyFailure(run: DailyRun, detail: string): Promise<void> {
  const summary = `[${hostname()}] Daily update recovery failed; automatic updates disabled`;
  const now = Date.now();
  currentDb().prepare(`INSERT OR IGNORE INTO error_tasks(id,severity,summary,log_excerpt,first_seen_at,last_seen_at,state)
    VALUES(?,?,?,?,?,?,'open')`).run(`daily-update:${run.id}`, 'critical', summary, detail, now, now);
  logger.error({ run_id: run.id, detail }, summary);
  const config = getDiscordNotificationConfig();
  if (!config?.enabled) run.notification = 'Error recorded in Errors; Discord notifications are not configured/enabled';
  else {
    try {
      await sendDiscordWebhook(config.webhookUrl, `${summary}\n${detail}\nRun: ${run.id}`);
      run.notification = 'Discord delivered';
    } catch {
      run.notification = 'Error recorded in Errors; Discord delivery failed';
      logger.error({ run_id: run.id }, 'daily update notification delivery failed');
    }
  }
  saveDailyRun(run);
}
