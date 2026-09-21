import type { OperationAction, OperationStatus, PeerLinkStatus, ServiceHealthState } from '../../lib/api';

/** @implements SPEC-FEDERATION-HEALTH-CACHE */

/** epoch ms を「N秒前 / N分前」で出す。 */
export function fmtAgo(at: number | null, now = Date.now()): string {
  if (at == null) return '—';
  const sec = Math.max(0, Math.round((now - at) / 1000));
  if (sec < 60) return `${sec}秒前`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}分前`;
  return `${Math.round(min / 60)}時間前`;
}

export const LINK_LABEL: Record<PeerLinkStatus, string> = {
  up: '接続',
  down: '不達',
  unauthorized: '認証NG',
  unregistered: '相互登録待ち',
  pending: '未確認',
};

export const OPERATION_LABEL: Record<OperationAction, string> = {
  update: '最新の更新',
  restart: '再起動',
  deploy: 'デプロイ',
  reflect: '反映',
  start: '起動',
  stop: '停止',
};

export const OPERATION_STATUS_LABEL: Record<OperationStatus, string> = {
  queued: '順番待ち',
  running: '実行中',
  restarting: '再起動中',
  succeeded: '完了',
  failed: '失敗',
};

/** epoch ms を 「MM/DD HH:mm」 で出す。 */
export function fmtTime(at: number | null): string {
  if (at == null) return '—';
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const HEALTH_LABEL: Record<ServiceHealthState, string> = {
  up: '稼働',
  down: '停止',
  unmonitored: '判定なし',
  unknown: '未確認',
};
