/**
 * 巡回 1 周ぶんのキャッシュ (peer-cache) と自拠点の資源アラートを alert-notifier に渡し、
 * Discord (downtime 通知と同じ webhook) へ送る。 本社として alert_notify を有効にした拠点だけが動く。
 */

import { currentResourceAlerts } from '../memory/resource-alerts.js';
import { sendDiscordWebhook } from '../notify/discord-webhook.js';
import { getDiscordNotificationConfig } from '../secrets/config-store.js';
import { createNamedLogger } from '../shared/logger.js';
import { createAlertStateStore, notifyAlerts, type AlertObservation } from './alert-notifier.js';
import { localNodeName } from './node-snapshot.js';
import { getPeerState, pendingPeerState } from './peer-cache.js';
import type { FederationSettings } from './settings.js';
import { listEnabledPeerIdentities } from './store.js';

const logger = createNamedLogger('excubitor.federation.alerts');
const store = createAlertStateStore();

export async function dispatchFederationAlerts(settings: FederationSettings, now = Date.now()): Promise<void> {
  if (!settings.alertNotify) return;
  const config = getDiscordNotificationConfig();
  if (!config?.enabled) {
    logger.debug('federation alert notify is on but Discord notifications are not configured');
    return;
  }
  const observations: AlertObservation[] = [
    { id: 'self', node: localNodeName(), status: 'up', error: null, alerts: currentResourceAlerts().alerts },
    ...listEnabledPeerIdentities().map((peer): AlertObservation => {
      const state = getPeerState(peer.id) ?? pendingPeerState(peer);
      return {
        id: peer.id,
        node: state.payload?.node ?? peer.name,
        status: state.status,
        error: state.error,
        alerts: state.status === 'up' ? state.payload?.alerts : undefined,
      };
    }),
  ];
  try {
    await notifyAlerts(store, observations, now, {
      peerDownAfterMs: settings.peerDownAfterMs,
      send: (text) => sendDiscordWebhook(config.webhookUrl, text),
    });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'federation alert notification failed; retrying next pass');
  }
}
