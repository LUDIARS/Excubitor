/**
 * Excubitor 設定 API (`/api/v1/config/*`)。
 *
 * Infisical の machine identity と各サービスのマッピングを Excubitor 設定ファイルに
 * 保存する。identity の clientId/clientSecret は salt 付き暗号化で保存され、平文は返さない。
 */

import { Hono } from 'hono';
import { z } from 'zod';
import {
  saveInfisicalIdentity,
  getInfisicalIdentity,
  getIdentityStatus,
  applyInfisicalToEnv,
  getServiceMap,
  setServiceMap,
  getDomainRootStatus,
  setDomainRootOverride,
  getDiscordNotificationConfig,
  getDiscordNotificationStatus,
  saveDiscordNotificationConfig,
} from './config-store.js';
import { verifyIdentity } from './infisical.js';
import { sendDiscordWebhook } from '../notify/discord-webhook.js';

const IdentitySchema = z.object({
  siteUrl: z.string().min(1),
  environment: z.string().optional(),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
});

const ServiceInfisicalSchema = z.object({
  project_id: z.string(),
  environment: z.string().default('dev'),
  inject: z.boolean().default(true),
  prefix: z.string().default(''),
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
  required_env: z.array(z.string()).optional(),
});

const ServicesSchema = z.object({
  services: z.record(z.string(), ServiceInfisicalSchema),
});

const DomainRootSchema = z.object({
  domain_root: z.string().min(1),
});

const NotificationSchema = z.object({
  webhook_url: z.string().optional(),
  enabled: z.boolean(),
  downtime_threshold_sec: z.number().int().min(60).max(86_400).default(60),
  notify_recovery: z.boolean().default(true),
  clear_webhook: z.boolean().optional(),
});

export interface ConfigRouterDeps {
  onDomainRootChanged?: () => unknown | Promise<unknown>;
}

export function buildConfigRouter(deps: ConfigRouterDeps = {}): Hono {
  const app = new Hono();

  // identity の状態 (configured / siteUrl / clientId ヒント) + サービスマッピング。
  app.get('/api/v1/config/infisical', (c) =>
    c.json({ identity: getIdentityStatus(), services: getServiceMap(), domain_root: getDomainRootStatus() }),
  );

  app.get('/api/v1/config/domain-root', (c) => c.json({ domain_root: getDomainRootStatus() }));

  app.get('/api/v1/config/notifications', (c) =>
    c.json({ discord: getDiscordNotificationStatus() }),
  );

  app.put('/api/v1/config/notifications/discord', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = NotificationSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_body', detail: parsed.error.flatten() }, 400);
    try {
      const discord = saveDiscordNotificationConfig({
        webhookUrl: parsed.data.webhook_url,
        enabled: parsed.data.enabled,
        downtimeThresholdSec: parsed.data.downtime_threshold_sec,
        notifyRecovery: parsed.data.notify_recovery,
        clearWebhook: parsed.data.clear_webhook,
      });
      return c.json({ ok: true, discord });
    } catch (err) {
      return c.json({ error: 'invalid_discord_webhook', message: (err as Error).message }, 400);
    }
  });

  app.post('/api/v1/config/notifications/discord/test', async (c) => {
    const config = getDiscordNotificationConfig();
    if (!config?.enabled) return c.json({ ok: false, message: 'Discord notifications are not enabled' }, 400);
    try {
      await sendDiscordWebhook(config.webhookUrl, '✅ Excubitor Discord webhook test succeeded.');
      return c.json({ ok: true, message: 'Discord webhook test succeeded' });
    } catch (err) {
      return c.json({ ok: false, message: (err as Error).message }, 502);
    }
  });

  app.put('/api/v1/config/domain-root', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = DomainRootSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_body', detail: parsed.error.flatten() }, 400);
    try {
      setDomainRootOverride(parsed.data.domain_root);
      await deps.onDomainRootChanged?.();
      return c.json({ ok: true, domain_root: getDomainRootStatus() });
    } catch (err) {
      return c.json({ error: 'invalid_domain_root', message: (err as Error).message }, 400);
    }
  });

  // identity を保存 (暗号化) し、 即 process.env に反映。
  app.put('/api/v1/config/infisical/identity', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = IdentitySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_body', detail: parsed.error.flatten() }, 400);
    saveInfisicalIdentity(parsed.data);
    applyInfisicalToEnv();
    return c.json({ ok: true, identity: getIdentityStatus() });
  });

  // 保存済 identity で Infisical に login できるか接続テストする (値は返さない)。
  app.post('/api/v1/config/infisical/test', async (c) => {
    const id = getInfisicalIdentity();
    if (!id) return c.json({ ok: false, message: 'identity 未設定です' }, 400);
    try {
      await verifyIdentity({ siteUrl: id.siteUrl, clientId: id.clientId, clientSecret: id.clientSecret });
      return c.json({ ok: true, message: '接続成功 (login OK)' });
    } catch (err) {
      return c.json({ ok: false, message: (err as Error).message });
    }
  });

  // 各サービスの Infisical マッピングを一括保存。
  app.put('/api/v1/config/infisical/services', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = ServicesSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_body', detail: parsed.error.flatten() }, 400);
    setServiceMap(parsed.data.services);
    return c.json({ ok: true, services: getServiceMap() });
  });

  return app;
}
