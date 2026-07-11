import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  getDiscordNotificationConfig,
  type DiscordNotificationConfig,
} from '../secrets/config-store.js';
import { createNamedLogger } from '../shared/logger.js';
import { sendDiscordWebhook } from '../notify/discord-webhook.js';
import type { HealthObservation } from './health-state.js';

const logger = createNamedLogger('excubitor.downtime-alert');
const RETRY_INTERVAL_MS = 30_000;

interface AlertState {
  service_code: string;
  down_since: number | null;
  notified_at: number | null;
  last_probe_at: number;
  last_attempt_at: number | null;
  last_error: string | null;
}

export interface DowntimeAlertDeps {
  now?: number;
  config?: DiscordNotificationConfig | null;
  send?: (webhookUrl: string, content: string) => Promise<void>;
}

export async function processDowntimeAlerts(
  observations: HealthObservation[],
  deps: DowntimeAlertDeps = {},
): Promise<void> {
  const now = deps.now ?? Date.now();
  const config = deps.config === undefined ? getDiscordNotificationConfig() : deps.config;
  const send = deps.send ?? sendDiscordWebhook;
  for (const observation of observations) {
    if (observation.ok) {
      await processRecovery(observation, now, config, send);
    } else {
      await processFailure(observation, now, config, send);
    }
  }
}

async function processFailure(
  observation: HealthObservation,
  now: number,
  config: DiscordNotificationConfig | null,
  send: (webhookUrl: string, content: string) => Promise<void>,
): Promise<void> {
  db().run(sql`
    INSERT INTO health_alert_state (service_code, down_since, last_probe_at, updated_at)
    VALUES (${observation.code}, ${now}, ${now}, ${now})
    ON CONFLICT(service_code) DO UPDATE SET
      down_since = COALESCE(health_alert_state.down_since, excluded.down_since),
      last_probe_at = excluded.last_probe_at,
      updated_at = excluded.updated_at
  `);
  const state = readState(observation.code);
  if (!state?.down_since || state.notified_at) return;
  const thresholdMs = (config?.downtimeThresholdSec ?? 60) * 1000;
  if (now - state.down_since < thresholdMs) return;
  if (!config?.enabled) return;
  if (state.last_attempt_at && now - state.last_attempt_at < RETRY_INTERVAL_MS) return;

  markAttempt(observation.code, now);
  const duration = formatDuration(now - state.down_since);
  try {
    await send(
      config.webhookUrl,
      [
        `🚨 **Service down: ${observation.name} (${observation.code})**`,
        `Down for ${duration} (since ${new Date(state.down_since).toISOString()}).`,
        `Health: ${observation.reason}${observation.detail ? ` — ${observation.detail}` : ''}`,
      ].join('\n'),
    );
    db().run(sql`
      UPDATE health_alert_state
      SET notified_at = ${now}, last_error = NULL, updated_at = ${now}
      WHERE service_code = ${observation.code}
    `);
    logger.warn({ code: observation.code, downSince: state.down_since }, 'downtime alert sent');
  } catch (err) {
    recordFailure(observation.code, now, err);
  }
}

async function processRecovery(
  observation: HealthObservation,
  now: number,
  config: DiscordNotificationConfig | null,
  send: (webhookUrl: string, content: string) => Promise<void>,
): Promise<void> {
  const state = readState(observation.code);
  if (!state?.down_since) return;
  if (!state.notified_at || !config?.enabled || !config.notifyRecovery) {
    clearIncident(observation.code, now);
    return;
  }
  if (state.last_attempt_at && now - state.last_attempt_at < RETRY_INTERVAL_MS) return;

  markAttempt(observation.code, now);
  try {
    await send(
      config.webhookUrl,
      [
        `✅ **Service recovered: ${observation.name} (${observation.code})**`,
        `Downtime: ${formatDuration(now - state.down_since)}.`,
        `Healthy at ${new Date(now).toISOString()}.`,
      ].join('\n'),
    );
    clearIncident(observation.code, now);
    logger.info({ code: observation.code }, 'recovery alert sent');
  } catch (err) {
    recordFailure(observation.code, now, err);
  }
}

function readState(code: string): AlertState | undefined {
  return db().get(sql`
    SELECT service_code, down_since, notified_at, last_probe_at, last_attempt_at, last_error
    FROM health_alert_state
    WHERE service_code = ${code}
  `) as AlertState | undefined;
}

function markAttempt(code: string, now: number): void {
  db().run(sql`
    UPDATE health_alert_state
    SET last_attempt_at = ${now}, updated_at = ${now}
    WHERE service_code = ${code}
  `);
}

function recordFailure(code: string, now: number, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  db().run(sql`
    UPDATE health_alert_state
    SET last_error = ${message}, updated_at = ${now}
    WHERE service_code = ${code}
  `);
  logger.warn({ code, err: message }, 'downtime notification failed');
}

function clearIncident(code: string, now: number): void {
  db().run(sql`
    UPDATE health_alert_state
    SET down_since = NULL,
        notified_at = NULL,
        last_attempt_at = NULL,
        last_error = NULL,
        last_probe_at = ${now},
        updated_at = ${now}
    WHERE service_code = ${code}
  `);
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
