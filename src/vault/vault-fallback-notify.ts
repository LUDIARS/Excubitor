import { sendDiscordWebhook } from '../notify/discord-webhook.js';
import { getDiscordNotificationConfig } from '../secrets/config-store.js';
import { createNamedLogger } from '../shared/logger.js';

/**
 * Log + best-effort Discord notification for Vault fallback events. Never includes values or
 * key names; a notification failure never blocks the service start.
 *
 * @implements SPEC-VAULT-CACHE-FALLBACK
 */

const logger = createNamedLogger('excubitor.vault.fallback');

export interface VaultFallbackEvent {
  kind: 'cache-used' | 'cache-discarded' | 'fallback-disabled';
  code: string;
  peer: string;
  status: number | null;
  error: string | null;
  fetchedAt?: number;
}

const MESSAGES: Record<VaultFallbackEvent['kind'], string> = {
  'cache-used': '本社 Vault に一時的に届かないため、最後に正常取得した控えで起動します',
  'cache-discarded': '本社 Vault が拒否 (失効) を返したため、控えを破棄し起動を止めました',
  'fallback-disabled': '本社 Vault に届かず、このサービスは控えでの起動が禁止されているため起動を止めました',
};

export function notifyVaultFallback(event: VaultFallbackEvent): void {
  const message = MESSAGES[event.kind];
  logger.warn({ ...event }, message);
  let config: ReturnType<typeof getDiscordNotificationConfig>;
  try { config = getDiscordNotificationConfig(); }
  catch { return; } // An unreadable notification config must not block the start.
  if (!config?.enabled) return;
  const fetched = event.fetchedAt ? ` (控えの取得 ${new Date(event.fetchedAt).toISOString()})` : '';
  void sendDiscordWebhook(config.webhookUrl, `[Excubitor Vault] ${event.code}: ${message}${fetched}`)
    .catch((error: unknown) => logger.warn({ err: (error as Error).message }, 'vault fallback notification failed'));
}
