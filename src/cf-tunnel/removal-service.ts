/**
 * CF ブローカーの削除の判断ロジック (純関数)。CF API 呼び出しは持たない
 * (cloudflare-*-api.ts / removal-router.ts が担う)。
 *
 * 消してよいのは「ブローカーが作る形のもの」だけに絞る:
 *   - DNS: tunnel を向いた CNAME (`<tunnel-id>.cfargotunnel.com`) のみ。別の向き先・別種は残す
 *   - Tunnel: 名前の打ち込み確認 + hostname 付きルートが 0 件 + cloudflared 未接続のときのみ
 *
 * @implements SPEC-CF-TUNNEL-ROUTES (spec/feature/cf-tunnel-routes.md)
 */

import type { CfIngressRule, CfTunnelSummary } from './cloudflare-api.js';
import type { CfDnsRecord } from './cloudflare-dns-api.js';
import { RouteRejectedError } from './route-service.js';

export type DnsRemovalPlan = { kind: 'absent' } | { kind: 'delete'; recordId: string };

/**
 * hostname のレコードから、tunnel を向いた CNAME だけを削除対象に選ぶ。
 * レコードが無ければ absent (冪等)。tunnel を向いていないレコードしか無ければ止める。
 * @implements SPEC-CF-TUNNEL-ROUTES
 */
export function planTunnelCnameRemoval(records: CfDnsRecord[], target: string): DnsRemovalPlan {
  if (records.length === 0) return { kind: 'absent' };
  const ours = records.find((r) => r.type === 'CNAME' && r.content.toLowerCase() === target.toLowerCase());
  if (!ours) {
    throw new RouteRejectedError(
      `hostname のレコード (${records.map((r) => r.type).join(', ')}) はこの tunnel を向いていない。消さないので手で確認する`,
    );
  }
  return { kind: 'delete', recordId: ours.id };
}

/** cloudflared が接続中の tunnel の status。CF も接続中の削除は拒否する。 */
const CONNECTED_STATUSES = new Set(['healthy', 'degraded']);

/**
 * Tunnel を消してよいか。名前の打ち込み一致・hostname 付きルートが 0 件 (catch-all のみ)・
 * cloudflared 未接続を要求する。allowlist 外のルートはブローカーで消せないので、それが残る
 * tunnel も消せない (他所で使っている tunnel を巻き込まない)。
 * @implements SPEC-CF-TUNNEL-ROUTES
 */
export function assertTunnelDeletable(tunnel: CfTunnelSummary, ingress: CfIngressRule[], confirm: string | undefined): void {
  if ((confirm ?? '').trim() !== tunnel.name) {
    throw new RouteRejectedError('確認のため confirm に tunnel 名をそのまま入れる');
  }
  const routed = ingress.filter((r) => Boolean(r.hostname)).map((r) => r.hostname as string);
  if (routed.length > 0) {
    throw new RouteRejectedError(`tunnel にルートが ${routed.length} 件残っている。先にルートを消す (${routed.join(', ')})`);
  }
  if (CONNECTED_STATUSES.has(tunnel.status)) {
    throw new RouteRejectedError(`cloudflared が接続中 (status=${tunnel.status})。先に cloudflared を止める`);
  }
}
