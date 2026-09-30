/**
 * 本社の Excubitor が、 ピア巡回の結果から「応答のない拠点」と「拠点の資源アラート」を Discord へ流す。
 *
 * 拠点は外へ出られない前提なので、 拠点から本社へ送らせず、 本社が既に回している巡回
 * (peer-poller) のキャッシュだけを材料にする。 通知は federation.alert_notify を有効にした
 * 拠点だけが行う (相互登録で全拠点が互いを巡回するため、 全拠点で鳴らすと重複する)。
 *
 * 送信に成功したときだけ状態を進めるので、 失敗した通知は次の巡回で再送される。
 */

import type { NodeResourceAlert, PeerLinkStatus } from './health-types.js';

export interface AlertObservation {
  /** 状態を引き継ぐためのキー (ピア id、 自拠点は `self`)。 */
  id: string;
  /** 通知に出す拠点名。 */
  node: string;
  /** この巡回で相手から応答が取れたか。 pending (未問い合わせ) は判定しない。 */
  status: PeerLinkStatus;
  error: string | null;
  /** 応答が取れたときの資源アラート。 旧版の拠点は送らないので undefined。 */
  alerts: NodeResourceAlert[] | undefined;
}

export interface NodeAlertState {
  downSince: number | null;
  downNotified: boolean;
  /** 通知済みの資源アラート (key → level)。 */
  notified: Map<string, NodeResourceAlert['level']>;
}

export interface AlertNotifierOptions {
  peerDownAfterMs: number;
  send: (text: string) => Promise<void>;
}

export type AlertStateStore = Map<string, NodeAlertState>;

export function createAlertStateStore(): AlertStateStore {
  return new Map();
}

export async function notifyAlerts(
  store: AlertStateStore,
  observations: readonly AlertObservation[],
  now: number,
  options: AlertNotifierOptions,
): Promise<void> {
  const seen = new Set(observations.map((observation) => observation.id));
  for (const id of [...store.keys()]) if (!seen.has(id)) store.delete(id);
  for (const observation of observations) {
    if (observation.status === 'pending') continue;
    const state = store.get(observation.id) ?? { downSince: null, downNotified: false, notified: new Map() };
    store.set(observation.id, state);
    if (observation.status === 'up') {
      await notifyRecovered(observation, state, now, options);
      await notifyResourceAlerts(observation, state, options);
    } else {
      await notifyUnreachable(observation, state, now, options);
    }
  }
}

async function notifyUnreachable(
  observation: AlertObservation,
  state: NodeAlertState,
  now: number,
  options: AlertNotifierOptions,
): Promise<void> {
  state.downSince ??= now;
  if (state.downNotified || now - state.downSince < options.peerDownAfterMs) return;
  await options.send([
    `🚨 **拠点が応答しません: ${observation.node}**`,
    `${formatDuration(now - state.downSince)} 応答なし (${new Date(state.downSince).toISOString()} から)。`,
    `状態: ${observation.status}${observation.error ? ` — ${observation.error}` : ''}`,
  ].join('\n'));
  state.downNotified = true;
}

async function notifyRecovered(
  observation: AlertObservation,
  state: NodeAlertState,
  now: number,
  options: AlertNotifierOptions,
): Promise<void> {
  if (state.downSince !== null && state.downNotified) {
    await options.send(`✅ **拠点が応答を再開: ${observation.node}** (応答なし ${formatDuration(now - state.downSince)})`);
  }
  state.downSince = null;
  state.downNotified = false;
}

async function notifyResourceAlerts(
  observation: AlertObservation,
  state: NodeAlertState,
  options: AlertNotifierOptions,
): Promise<void> {
  if (observation.alerts === undefined) return;
  const current = new Map(observation.alerts.map((alert) => [alert.key, alert]));
  const raised = observation.alerts.filter((alert) => {
    const previous = state.notified.get(alert.key);
    return previous === undefined || (previous === 'warn' && alert.level === 'critical');
  });
  const resolved = [...state.notified.keys()].filter((key) => !current.has(key));
  if (raised.length > 0) {
    await options.send([
      `⚠️ **拠点の資源アラート: ${observation.node}**`,
      ...raised.map((alert) => `- [${alert.level}] ${alert.message}`),
    ].join('\n'));
    for (const alert of raised) state.notified.set(alert.key, alert.level);
  }
  if (resolved.length > 0) {
    await options.send(`✅ **資源アラート解消: ${observation.node}** (${resolved.map(alertLabel).join(', ')})`);
    for (const key of resolved) state.notified.delete(key);
  }
  // 下がった重大度は黙って記録し、 再度 critical になったら鳴らす。
  for (const alert of observation.alerts) {
    if (state.notified.get(alert.key) === 'critical' && alert.level === 'warn') state.notified.set(alert.key, 'warn');
  }
}

function alertLabel(key: string): string {
  if (key === 'memory') return 'メモリ';
  if (key === 'cpu') return 'CPU';
  return key.startsWith('disk:') ? 'ストレージ ' + key.slice(5) : key;
}

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} 分`;
  return `${Math.floor(minutes / 60)} 時間 ${minutes % 60} 分`;
}
