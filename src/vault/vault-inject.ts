/**
 * サービス起動時に Vault の値を env として解決する。
 *
 * - 本社 (そのサービスの紐付けを自分で持つ): 自分の Vault から。未登録の値があれば起動を止める。
 * - 拠点 (取得元ピアを設定済み): 本社から受け取り、控えを更新する。本社に届かなければ控えを使う。
 *   控えも無ければ Vault 分は空で進める (Vault を使わないサービスまで本社の停止で止めないため。
 *   必須の変数が欠ければ startup-env の検査で名前付きで止まる)。
 * - 拠点の上書き (overrides) があれば、本社の値 (または控え) に拠点の値を後勝ちで重ねる。
 *   上書きの値が未登録なら本社の値へ戻さず起動を止める。控えには本社の値だけを保存する。
 */

import { z } from 'zod';
import { createNamedLogger } from '../shared/logger.js';
import { fetchVaultEnv } from '../federation/client.js';
import { getPeer, type RemotePeer } from '../federation/store.js';
import type { PeerCallResult } from '../federation/client.js';
import { sharedVault, type Vault } from './vault.js';

const VaultEnvResponseSchema = z.object({
  env: z.record(z.string()),
  missing: z.array(z.string()).default([]),
});

const logger = createNamedLogger('excubitor.vault.inject');

export interface VaultInjectDeps {
  vault?: Vault;
  getPeer?: (id: string) => RemotePeer | null;
  fetch?: (peer: RemotePeer, service: string) => Promise<PeerCallResult<unknown>>;
}

export async function resolveVaultEnv(code: string, deps: VaultInjectDeps = {}): Promise<Record<string, string>> {
  const vault = deps.vault ?? sharedVault();
  const local = await vault.envFor(code);
  if (local) {
    assertComplete(code, local.missing);
    return local.env;
  }
  const sourceId = vault.sourcePeerId();
  if (!sourceId) return {};
  const site = await vault.overrideEnvFor(code);
  if (site && site.missing.length > 0) {
    throw new Error(`service ${code} has site overrides whose Vault values are not set: ${site.missing.join(', ')}`);
  }
  const overlay = (base: Record<string, string>) => (site ? { ...base, ...site.env } : base);
  const peer = (deps.getPeer ?? getPeer)(sourceId);
  if (!peer || !peer.enabled) {
    logger.warn({ code, sourceId }, 'vault source peer is not registered or disabled; using cached values if any');
    return overlay((await vault.cachedEnv(code))?.env ?? {});
  }
  const result = await (deps.fetch ?? fetchVaultEnv)(peer, code);
  const body = result.ok ? VaultEnvResponseSchema.safeParse(result.data) : null;
  if (body?.success) {
    // 拠点が上書きする名前は本社で未登録でも止めない。
    assertComplete(code, body.data.missing.filter((name) => !(site && name in site.env)));
    await vault.cacheEnv(code, body.data.env);
    return overlay(body.data.env);
  }
  if (result.status === 404) return overlay({}); // 本社で紐付けが無い = Vault を使わないサービス (上書きだけ使う)
  const cached = await vault.cachedEnv(code);
  logger.warn(
    { code, peer: peer.name, error: result.error, cachedAt: cached?.fetched_at ?? null },
    cached ? 'vault source unreachable; using cached values' : 'vault source unreachable and no cached values',
  );
  return overlay(cached?.env ?? {});
}

function assertComplete(code: string, missing: readonly string[]): void {
  if (missing.length > 0) throw new Error(`service ${code} uses Vault values that are not set: ${missing.join(', ')}`);
}
