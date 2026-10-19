/**
 * 本社から拠点へ Vault の値を渡す公開面 (拠点間リスナーにも載る、相互登録の署名が必須)。
 *
 *   POST /api/v1/federation/vault/env   { service }  → { env, missing }
 *
 * Cr が許可したサービス・秘密キーの分だけを渡す。health の coverage は認可に使わない。
 * 渡した記録 (拠点・サービス・変数名) はログに残す。値そのものは残さない。
 */

import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { createNamedLogger } from '../shared/logger.js';
import { selectVaultKeys, vaultKeysFor } from '../federation/security/grants.js';
import type { FederationEnv } from '../federation/peer-auth.js';
import type { Vault } from './vault.js';

const logger = createNamedLogger('excubitor.vault.federation');

const RequestSchema = z.object({ service: z.string().min(1).max(128) });

export interface VaultPublicRoutesDeps {
  auth: MiddlewareHandler<FederationEnv>;
  vault: () => Vault;
}

export function buildVaultPublicRoutes(deps: VaultPublicRoutesDeps): Hono<FederationEnv> {
  const app = new Hono<FederationEnv>();

  app.post('/api/v1/federation/vault/env', deps.auth, async (c) => {
    const parsed = RequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
    const caller = c.get('federationCaller');
    const { service } = parsed.data;
    const allowed = vaultKeysFor(caller, service);
    if (allowed.length === 0) {
      logger.warn({ peer: caller.peerName, service }, 'vault grant denied');
      return c.json({ error: 'vault_grant_required' }, 403);
    }
    const result = await deps.vault().envFor(service);
    if (!result) return c.json({ error: 'not_bound' }, 404);
    // Recheck expiry after asynchronous decryption before releasing any value.
    const currentAllowed = vaultKeysFor(caller, service);
    if (currentAllowed.length === 0) return c.json({ error: 'vault_grant_expired' }, 403);
    const names = selectVaultKeys({ allowed: currentAllowed, names: Object.keys(result.env) });
    const missing = selectVaultKeys({ allowed: currentAllowed, names: result.missing });
    const env = Object.fromEntries(names.map(name => [name, result.env[name]]));
    logger.info({ peer: caller.peerName, service, names, missing }, 'vault values delivered to peer');
    return c.json({ env, missing });
  });

  return app;
}
