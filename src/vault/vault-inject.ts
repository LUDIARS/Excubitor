/**
 * サービス起動時に Vault の値を env として解決する。
 *
 * - 本社 (そのサービスの紐付けを自分で持つ): 自分の Vault から。未登録の値があれば起動を止める。
 * - 拠点 (取得元ピアを設定済み): 本社から現在の grant で受け取る。
 *   一時障害 (届かない / timeout / 5xx) のときだけ最後に正常取得した控えで起動し、ログと通知を出す。
 *   失効・拒否 (401/403、管理者による peer policy 削除) では控えを使わず破棄する。
 *   catalog の `vault_cache_fallback: false` のサービスは控えを保存せず、一時障害でも起動を止める。
 *   判断は vault-fallback.ts の純関数。spec/feature/vault.md#SPEC-VAULT-CACHE-FALLBACK
 * - 拠点の上書きは認可済みの本社値または利用可能な控えに重ねる。控えには本社値だけを保存する。
 *   上書き値が未登録なら起動を止め、認可拒否を上書きで回避しない。
 */

import { z } from 'zod';
import { createNamedLogger } from '../shared/logger.js';
import { fetchVaultEnv } from '../federation/client.js';
import { getPeer, type RemotePeer } from '../federation/store.js';
import type { PeerCallResult } from '../federation/client.js';
import { sharedVault, type Vault } from './vault.js';
import { getServiceByCode } from '../process/service-registry.js';
import { classifyVaultFetchFailure, decideVaultFallback } from './vault-fallback.js';
import { notifyVaultFallback, type VaultFallbackEvent } from './vault-fallback-notify.js';

const VaultEnvResponseSchema = z.object({
  env: z.record(z.string()),
  missing: z.array(z.string()).default([]),
});

const logger = createNamedLogger('excubitor.vault.inject');

export interface VaultInjectDeps {
  vault?: Vault;
  getPeer?: (id: string) => RemotePeer | null;
  fetch?: (peer: RemotePeer, service: string) => Promise<PeerCallResult<unknown>>;
  /** catalog `vault_cache_fallback` (省略時 true)。 */
  cacheFallbackAllowed?: (code: string) => boolean;
  notify?: (event: VaultFallbackEvent) => void;
}

function catalogAllowsCacheFallback(code: string): boolean {
  return getServiceByCode(code)?.vault_cache_fallback !== false;
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
    throw new Error('vault_source_not_authorized');
  }
  const fallbackAllowed = (deps.cacheFallbackAllowed ?? catalogAllowsCacheFallback)(code);
  const notify = deps.notify ?? notifyVaultFallback;
  const result = await (deps.fetch ?? fetchVaultEnv)(peer, code);
  const body = result.ok ? VaultEnvResponseSchema.safeParse(result.data) : null;
  if (body?.success) {
    assertComplete(code, body.data.missing.filter((name) => !(site && Object.hasOwn(site.env, name))));
    // 秘匿性の高いサービスは控えを持たない (古い控えも残さない)。
    if (fallbackAllowed) await vault.cacheEnv(code, body.data.env);
    else vault.dropCachedEnv(code);
    return overlay(body.data.env);
  }
  const outcome = result.ok ? 'rejected' : classifyVaultFetchFailure(result);
  if (outcome === 'unbound') return overlay({}); // 本社に紐付けがない場合は拠点の上書きだけを使う
  const cached = outcome === 'transient' && fallbackAllowed ? await readCache(vault, code) : null;
  const decision = decideVaultFallback({ outcome, fallbackAllowed, hasCache: cached !== null });
  const event = { code, peer: peer.name, status: result.status, error: result.error };
  if (decision.kind === 'use-cache' && cached) {
    notify({ ...event, kind: 'cache-used', fetchedAt: cached.fetched_at });
    return overlay(cached.env);
  }
  if (decision.kind === 'fail' && decision.discardCache) {
    vault.dropCachedEnv(code);
    notify({ ...event, kind: outcome === 'revoked' ? 'cache-discarded' : 'fallback-disabled' });
  } else {
    logger.warn({ ...event, outcome }, 'vault authorization unavailable');
  }
  // Existing processes retain their environment; only this new resolution fails.
  throw new Error(decision.kind === 'fail' ? decision.error : 'vault_authorization_unavailable');
}

async function readCache(vault: Vault, code: string): Promise<{ env: Record<string, string>; fetched_at: number } | null> {
  try {
    return await vault.cachedEnv(code);
  } catch (error) {
    // A cache that cannot be opened is treated as absent, never as a partial secret set.
    logger.warn({ code, err: (error as Error).message }, 'vault cache unreadable');
    return null;
  }
}

function assertComplete(code: string, missing: readonly string[]): void {
  if (missing.length > 0) throw new Error(`service ${code} uses Vault values that are not set: ${missing.join(', ')}`);
}
