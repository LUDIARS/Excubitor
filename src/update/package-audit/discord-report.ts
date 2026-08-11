/**
 * 監査レポートを専用 Discord webhook (downtime 通知とは別) へ送る。
 *
 * @implements SPEC-PACKAGE-UPDATE-AUDIT
 */

import { sendDiscordWebhook } from '../../notify/discord-webhook.js';
import { getPackageAuditDiscordConfig } from '../../secrets/config-store.js';
import { formatPackageAuditDiscordMessages } from './format.js';
import type { PackageAuditReport } from './types.js';

export async function sendPackageAuditDiscordReport(report: PackageAuditReport): Promise<void> {
  const config = getPackageAuditDiscordConfig();
  if (!config?.enabled) {
    throw new Error('package audit Discord webhook is not configured or enabled');
  }
  for (const message of formatPackageAuditDiscordMessages(report)) {
    await sendDiscordWebhook(config.webhookUrl, message);
  }
}
