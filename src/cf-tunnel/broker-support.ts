/**
 * CF ブローカーの各 router が共有する解決処理 (allowlist・tunnel・失敗の HTTP 区分)。
 *
 * @implements SPEC-CF-TUNNEL-ROUTES (spec/feature/cf-tunnel-routes.md)
 */

import { getCfTunnelSettings } from '../secrets/config-store.js';
import type { CloudflareTunnelApi, CfTunnelSummary } from './cloudflare-api.js';
import { readAllowedHostnames, RouteRejectedError } from './route-service.js';

/** allowlist の解決 (env 優先 → config store)。 @implements SPEC-CF-TUNNEL-ROUTES */
export function currentAllowlist(): string[] {
  return readAllowedHostnames(process.env, getCfTunnelSettings().allowedHostnames ?? []);
}

/** 入力拒否 (allowlist 外・重複等) は 400、CF 側の失敗は 502 に振り分ける。 */
export function failureStatus(err: unknown): 400 | 502 {
  return err instanceof RouteRejectedError ? 400 : 502;
}

/**
 * tunnel パラメータ (id か name) を解決。未指定はアカウント唯一の tunnel に限り許す。
 *
 * 見つからない場合もアカウント内の tunnel 名は列挙しない: 呼び出し側 (AI セッション) は
 * allowlist 経由の狭い操作しか許されておらず、無関係な tunnel の存在自体が
 * インフラ構成の漏洩になる (§14 トークン境界と同じ理由)。件数だけ返す。
 * @implements SPEC-CF-TUNNEL-ROUTES
 */
export async function resolveTunnel(
  api: CloudflareTunnelApi,
  param: string | undefined,
): Promise<CfTunnelSummary> {
  const tunnels = await api.listTunnels();
  if (param) {
    const found = tunnels.find((t) => t.id === param || t.name === param);
    if (!found) {
      throw new Error(`tunnel "${param}" が見つからない (アカウント内 ${tunnels.length} 件と不一致)`);
    }
    return found;
  }
  if (tunnels.length === 1 && tunnels[0]) return tunnels[0];
  throw new Error(
    `tunnel を指定してください (tunnel=<id|name>)。アカウント内の tunnel は ${tunnels.length} 件`,
  );
}
