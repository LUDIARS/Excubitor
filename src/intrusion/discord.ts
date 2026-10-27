import { sendDiscordWebhook } from '../notify/discord-webhook.js';
import type { Incident } from './store.js';
import type { AccessEvidence, DetectionReason } from './detection.js';

export async function reportRequestDenial(webhook: string, site: string, event: AccessEvidence, reason: DetectionReason): Promise<void> {
  await sendDiscordWebhook(webhook, ['不正アクセス監視: 不審な通信を検知しました（入口全体の遮断なし）',
    `拠点: ${site}`, `対象サービス: ${event.service}`, `検知: ${reason}`,
    `時刻: ${new Date(event.at).toISOString()}`, '許可国の通常アクセスを継続します。詳細はアクセスログを確認してください。'].join('\n'));
}

export function incidentMessage(incident: Incident): string {
  // All labels are configured/schema-controlled. Never put incoming URL/IP in Discord.
  return ['不正アクセス監視: 公開入口を遮断しました',
    `拠点: ${incident.site}`, `対象サービス: ${incident.service}`,
    `検知: ${incident.reason}`, `時刻: ${new Date(incident.at).toISOString()}`,
    `Cloudflare遮断確認: ${incident.containment}`,
    `記録保存: ${incident.persistenceFailed ? '失敗（公開停止を継続）' : '保存済み'}`,
    `Incident: ${incident.id}`, '自動復旧はしません。管理用の接続から調査してください。'].join('\n');
}
export async function reportIncident(webhook: string, incident: Incident): Promise<void> {
  await sendDiscordWebhook(webhook, incidentMessage(incident));
}
