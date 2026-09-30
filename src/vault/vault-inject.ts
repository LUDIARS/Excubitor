/**
 * サービス起動時に Vault の値を env として解決する。
 *
 * - 本社 (そのサービスの紐付けを自分で持つ): 自分の Vault から。未登録の値があれば起動を止める。
 * - 拠点 (取得元ピアを設定済み): 本社から受け取り、控えを更新する。本社に届かなければ控えを使う。
 *   控えも無ければ Vault 分は空で進める (Vault を使わないサービスまで本社の停止で止めないため。
 *   必須の変数が欠ければ startup-env の検査で名前付きで止まる)。
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
  const peer = (deps.getPeer ?? getPeer)(sourceId);
  if (!peer || !peer.enabled) {
    logger.warn({ code, sourceId }, 'vault source peer is not registered or disabled; using cached values if any');
    return (await vault.cachedEnv(code))?.env ?? {};
  }
  const result = await (deps.fetch ?? fetchVaultEnv)(peer, code);
  const body = result.ok ? VaultEnvResponseSchema.safeParse(result.data) : null;
  if (body?.success) {
    assertComplete(code, body.data.missing);
    await vault.cacheEnv(code, body.data.env);
    return body.data.env;
  }
  if (result.status === 404) return {}; // 本社で紐付けが無い = Vault を使わないサービス
  const cached = await vault.cachedEnv(code);
  logger.warn(
    { code, peer: peer.name, error: result.error, cachedAt: cached?.fetched_at ?? null },
    cached ? 'vault source unreachable; using cached values' : 'vault source unreachable and no cached values',
  );
  return cached?.env ?? {};
}

function assertComplete(code: string, missing: readonly string[]): void {
  if (missing.length > 0) throw new Error(`service ${code} uses Vault values that are not set: ${missing.join(', ')}`);
}
