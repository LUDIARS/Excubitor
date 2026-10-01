/**
 * Access アプリ / DNS / Access 必須 route の判断ロジック (純関数)。CF API 呼び出しは持たない
 * (cloudflare-*-api.ts / access-router.ts が担う)。
 *
 * @implements SPEC-CF-TUNNEL-ROUTES (spec/feature/cf-tunnel-routes.md)
 */

import type { CfAccessApp, CfAccessPolicy } from './cloudflare-access-api.js';
import type { CfDnsRecord } from './cloudflare-dns-api.js';
import { RouteRejectedError } from './route-service.js';

const TEAM_DOMAIN = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.cloudflareaccess\.com$/;
const AUDIENCE = /^[a-f0-9]{64}$/i;
const APP_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

/** アプリの domain と hostname の一致 (パス無しの完全一致のみ)。 @implements SPEC-CF-TUNNEL-ROUTES */
export function findAppForHostname(apps: CfAccessApp[], hostname: string): CfAccessApp | null {
  const host = hostname.trim().toLowerCase();
  return apps.find((a) => a.domain.trim().toLowerCase() === host) ?? null;
}

/**
 * 付けるポリシーは既存の再利用 Allow ポリシーに限る (ここで新規ポリシーは作らない)。
 * @implements SPEC-CF-TUNNEL-ROUTES
 */
export function requireAllowPolicy(policies: CfAccessPolicy[], policyId: string): CfAccessPolicy {
  const policy = policies.find((p) => p.id === policyId.trim());
  if (!policy) throw new RouteRejectedError(`再利用ポリシー ${policyId} が見つからない`);
  if (policy.decision !== 'allow') {
    throw new RouteRejectedError(`ポリシー "${policy.name}" は Allow ではない (decision=${policy.decision})`);
  }
  return policy;
}

/** @implements SPEC-CF-TUNNEL-ROUTES */
export function assertAppName(name: string): string {
  const trimmed = name.trim();
  if (!APP_NAME.test(trimmed)) throw new RouteRejectedError('name は英数字で始まる 64 文字以内 (英数字・空白・._-)');
  return trimmed;
}

export interface AccessIdentity {
  teamDomain: string;
  teamName: string;
  audience: string;
}

/** 組織の auth_domain とアプリの aud を検証して組む。 @implements SPEC-CF-TUNNEL-ROUTES */
export function accessIdentity(authDomain: string, app: CfAccessApp): AccessIdentity {
  const teamDomain = authDomain.trim().toLowerCase();
  const match = TEAM_DOMAIN.exec(teamDomain);
  if (!match || !AUDIENCE.test(app.aud)) {
    throw new Error('Access の team / AUD を取得できないか形式が不正');
  }
  return { teamDomain, teamName: match[1] as string, audience: app.aud.toLowerCase() };
}

/**
 * サービスの runtime-config に cloudflareAccess を差し込む。他のキーは保持する。
 * @implements SPEC-CF-TUNNEL-ROUTES
 */
export function withCloudflareAccess(
  current: Record<string, unknown> | null,
  identity: AccessIdentity,
): Record<string, unknown> {
  return {
    ...(current ?? {}),
    cloudflareAccess: { teamDomain: identity.teamDomain, audience: identity.audience },
  };
}

/** cloudflared が JWT を検証してから origin へ渡す route 設定。 @implements SPEC-CF-TUNNEL-ROUTES */
export function accessOriginRequest(identity: AccessIdentity): Record<string, unknown> {
  return { access: { required: true, teamName: identity.teamName, audTag: [identity.audience] } };
}

/**
 * hostname を含む zone 名の候補 (長い順)。`a.b.example.com` → `b.example.com`, `example.com`。
 * @implements SPEC-CF-TUNNEL-ROUTES
 */
export function zoneCandidates(hostname: string): string[] {
  const labels = hostname.trim().toLowerCase().split('.').filter(Boolean);
  const out: string[] = [];
  for (let i = 1; i <= labels.length - 2; i += 1) out.push(labels.slice(i).join('.'));
  return out;
}

export type DnsPlan = { kind: 'exists' } | { kind: 'create' };

/**
 * 同じ hostname の既存レコードを見て、作るか・既に正しいか・止めるかを決める。
 * 別の向き先や別種のレコードは上書きしない。
 * @implements SPEC-CF-TUNNEL-ROUTES
 */
export function planTunnelCname(records: CfDnsRecord[], target: string): DnsPlan {
  if (records.length === 0) return { kind: 'create' };
  const same = records.find((r) => r.type === 'CNAME' && r.content.toLowerCase() === target.toLowerCase());
  if (same && records.length === 1) {
    if (!same.proxied) throw new RouteRejectedError('同じ向き先の CNAME があるが proxied ではない (手で確認する)');
    return { kind: 'exists' };
  }
  throw new RouteRejectedError(
    `hostname に別のレコードがある (${records.map((r) => r.type).join(', ')})。上書きしないので手で確認する`,
  );
}
