/**
 * Tunnel ingress ルールの編集ロジック (純関数) + hostname allowlist。
 *
 * 「狭い専用 API」の中核: 変更は allowlist に載る hostname に限り、catch-all
 * (hostname 無しの最終ルール) は読み取り専用。CF API 呼び出しは持たない
 * (cloudflare-api.ts / router.ts が担う) — SRP でロジックだけを単体テスト可能に保つ。
 *
 * @implements SPEC-CF-TUNNEL-ROUTES (spec/feature/cf-tunnel-routes.md)
 */

import type { CfIngressRule } from './cloudflare-api.js';

/**
 * 呼び出し側の入力が拒否されたことを示す (allowlist 外・重複・catch-all 不在等)。
 * CF 側の障害 (502) と区別して 400 で返すため、router がこの型で判別する。
 */
export class RouteRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RouteRejectedError';
  }
}

export interface RouteKey {
  hostname: string;
  path?: string;
}

export interface AddRouteInput extends RouteKey {
  service: string;
}

/**
 * env のカンマ区切り allowlist を読む。未設定・空は「全 hostname 変更禁止」(fail-closed)。
 * @implements SPEC-CF-TUNNEL-ROUTES
 */
export function readAllowedHostnames(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.EXCUBITOR_CF_TUNNEL_ALLOWED_HOSTNAMES ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);
}

/** @implements SPEC-CF-TUNNEL-ROUTES */
export function isHostnameAllowed(hostname: string, allowed: string[]): boolean {
  return allowed.includes(hostname.trim().toLowerCase());
}

function assertMutable(hostname: string, allowed: string[]): void {
  if (!isHostnameAllowed(hostname, allowed)) {
    throw new RouteRejectedError(
      `hostname "${hostname}" は allowlist (EXCUBITOR_CF_TUNNEL_ALLOWED_HOSTNAMES) に無いため変更できない`,
    );
  }
}

function sameKey(rule: CfIngressRule, key: RouteKey): boolean {
  return (
    (rule.hostname ?? '').trim().toLowerCase() === key.hostname.trim().toLowerCase() &&
    (rule.path ?? '').trim() === (key.path ?? '').trim()
  );
}

/**
 * catch-all (hostname 無しの最終ルール) の位置。CF ingress は上から評価されるため
 * catch-all は必ず末尾の 1 件で、それ以前の hostname 無しエントリは想定外の壊れた
 * config を意味する。末尾以外を catch-all とみなすと、新ルールを「既に全部を飲み込む
 * エントリ」の後ろに挿してしまい無言で死ぬので、末尾だけを見る。
 * catch-all が無ければ -1。
 */
function catchAllIndexOf(ingress: CfIngressRule[]): number {
  const last = ingress.length - 1;
  return last >= 0 && !ingress[last]?.hostname ? last : -1;
}

/**
 * ルール追加。catch-all (hostname 無し) の直前に挿入する。
 * catch-all が無い構成は想定外なので変更せずエラー (壊れた config を上書きしない)。
 * @implements SPEC-CF-TUNNEL-ROUTES
 */
export function addRoute(
  ingress: CfIngressRule[],
  input: AddRouteInput,
  allowed: string[],
): CfIngressRule[] {
  assertMutable(input.hostname, allowed);
  if (!input.service.trim()) throw new RouteRejectedError('service が空');
  if (ingress.some((r) => r.hostname && sameKey(r, input))) {
    throw new RouteRejectedError(
      `同じ hostname+path のルールが既に存在する: ${input.hostname} ${input.path ?? ''}`,
    );
  }
  const catchAllIndex = catchAllIndexOf(ingress);
  if (catchAllIndex < 0) {
    throw new RouteRejectedError(
      'catch-all ルール (hostname 無しの最終エントリ) が見つからない。config が想定外のため変更を中止',
    );
  }
  const rule: CfIngressRule = {
    hostname: input.hostname.trim(),
    service: input.service.trim(),
    ...(input.path ? { path: input.path } : {}),
  };
  return [...ingress.slice(0, catchAllIndex), rule, ...ingress.slice(catchAllIndex)];
}

/**
 * ルール削除。catch-all は削除対象にできない。完全一致 (hostname+path) のみ。
 * @implements SPEC-CF-TUNNEL-ROUTES
 */
export function removeRoute(
  ingress: CfIngressRule[],
  key: RouteKey,
  allowed: string[],
): CfIngressRule[] {
  assertMutable(key.hostname, allowed);
  const catchAllIndex = catchAllIndexOf(ingress);
  const index = ingress.findIndex((r, i) => r.hostname && i !== catchAllIndex && sameKey(r, key));
  if (index < 0) {
    throw new RouteRejectedError(`一致するルールが無い: ${key.hostname} ${key.path ?? '(path なし)'}`);
  }
  return [...ingress.slice(0, index), ...ingress.slice(index + 1)];
}

/**
 * 一覧表示用。mutable = allowlist に載っているか。catch-all は hostname: null で示す。
 * @implements SPEC-CF-TUNNEL-ROUTES
 */
export function describeRoutes(
  ingress: CfIngressRule[],
  allowed: string[],
): Array<{ hostname: string | null; path: string | null; service: string; mutable: boolean }> {
  const catchAllIndex = catchAllIndexOf(ingress);
  return ingress.map((r, i) => ({
    hostname: r.hostname ?? null,
    path: r.path ?? null,
    service: r.service,
    mutable: Boolean(r.hostname) && i !== catchAllIndex && isHostnameAllowed(r.hostname!, allowed),
  }));
}
