import type { PeerLinkStatus, ServiceHealthState } from '../../lib/api';

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
  pending: '未確認',
};

export const HEALTH_LABEL: Record<ServiceHealthState, string> = {
  up: '稼働',
  down: '停止',
  unmonitored: '判定なし',
  unknown: '未確認',
};
