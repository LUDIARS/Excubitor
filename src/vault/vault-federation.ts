/**
 * 本社から拠点へ Vault の値を渡す公開面 (拠点間リスナーにも載る、相互登録の署名が必須)。
 *
 *   POST /api/v1/federation/vault/env   { service }  → { env, missing }
 *
 * 渡すのは、呼び出した拠点が担保しているサービス (本社が巡回で受け取った相手の health で
 * covered=true) の分だけ。拠点が任意のサービスの値を引けないようにする。
 * 渡した記録 (拠点・サービス・変数名) はログに残す。値そのものは残さない。
 */

import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { createNamedLogger } from '../shared/logger.js';
import { getPeerState } from '../federation/peer-cache.js';
import type { FederationEnv } from '../federation/peer-auth.js';
import type { Vault } from './vault.js';

const logger = createNamedLogger('excubitor.vault.federation');

const RequestSchema = z.object({ service: z.string().min(1).max(128) });

export interface VaultPublicRoutesDeps {
  auth: MiddlewareHandler<FederationEnv>;
  vault: () => Vault;
  /** ピアが担保しているサービスか (既定は巡回キャッシュの covered)。 */
  covers?: (peerId: string, service: string) => boolean;
}

export function peerCoversService(peerId: string, service: string): boolean {
  const payload = getPeerState(peerId)?.payload;
  return payload?.services.some((entry) => entry.code === service && entry.covered) ?? false;
}

export function buildVaultPublicRoutes(deps: VaultPublicRoutesDeps): Hono<FederationEnv> {
  const app = new Hono<FederationEnv>();
  const covers = deps.covers ?? peerCoversService;

  app.post('/api/v1/federation/vault/env', deps.auth, async (c) => {
    const parsed = RequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
    const caller = c.get('federationCaller');
    const { service } = parsed.data;
    if (!covers(caller.peerId, service)) {
      logger.warn({ peer: caller.peerName, service }, 'vault request for a service the peer does not cover');
      return c.json({ error: 'service_not_covered' }, 403);
    }
    const result = await deps.vault().envFor(service);
    if (!result) return c.json({ error: 'not_bound' }, 404);
    logger.info({ peer: caller.peerName, service, names: Object.keys(result.env), missing: result.missing }, 'vault values delivered to peer');
    return c.json(result);
  });

  return app;
}
