/**
 * Vault の管理 API (loopback の本体のみ。拠点間リスナーには載せない)。
 *
 *   GET    /api/v1/vault                           名前・更新日時・紐付け・取得元 (値は返さない)
 *   PUT    /api/v1/vault/entries/:name             { value }  値を登録 / 差し替え
 *   DELETE /api/v1/vault/entries/:name
 *   PUT    /api/v1/vault/bindings/:code            { names }  サービスが使う環境変数
 *   PUT    /api/v1/vault/source                    { peer_id } 拠点: 値を受け取る本社 (null で本社扱い)
 *   POST   /api/v1/vault/import/infisical/:code    Infisical の値を Vault へ移し、紐付けに足す
 *
 * 平文を返す口は作らない。値を確かめたいときは差し替える。
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { resolveServiceSecrets } from '../secrets/resolve.js';
import type { ServiceInfisical } from '../secrets/config-store.js';
import { createNamedLogger } from '../shared/logger.js';
import { getPeer } from '../federation/store.js';
import { VaultError, type Vault } from './vault.js';

const logger = createNamedLogger('excubitor.vault.router');

const ValueSchema = z.object({ value: z.string().min(1) });
const BindingsSchema = z.object({ names: z.array(z.string()).max(256) });
const SourceSchema = z.object({ peer_id: z.string().min(1).nullable() });

export interface VaultRouterDeps {
  vault: () => Vault;
  getCatalogInfisical: (code: string) => ServiceInfisical | undefined;
  /** 取得元に指定できるピアか (既定: 登録済み)。 */
  peerExists?: (id: string) => boolean;
  resolveInfisical?: typeof resolveServiceSecrets;
}

export function buildVaultRouter(deps: VaultRouterDeps): Hono {
  const app = new Hono();
  const peerExists = deps.peerExists ?? ((id: string) => getPeer(id) !== null);
  const resolveInfisical = deps.resolveInfisical ?? resolveServiceSecrets;

  app.get('/api/v1/vault', (c) => c.json(deps.vault().status()));

  app.put('/api/v1/vault/entries/:name', async (c) => {
    const parsed = ValueSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
    return handle(c, async () => {
      await deps.vault().setEntry(c.req.param('name'), parsed.data.value);
      logger.info({ name: c.req.param('name') }, 'vault entry saved');
      return { ok: true };
    });
  });

  app.delete('/api/v1/vault/entries/:name', (c) => {
    const existed = deps.vault().deleteEntry(c.req.param('name'));
    if (existed) logger.info({ name: c.req.param('name') }, 'vault entry deleted');
    return existed ? c.json({ ok: true }) : c.json({ error: 'not_found' }, 404);
  });

  app.put('/api/v1/vault/bindings/:code', async (c) => {
    const parsed = BindingsSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
    return handle(c, async () => {
      deps.vault().setBindings(c.req.param('code'), parsed.data.names);
      return { ok: true };
    });
  });

  app.put('/api/v1/vault/source', async (c) => {
    const parsed = SourceSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
    if (parsed.data.peer_id && !peerExists(parsed.data.peer_id)) return c.json({ error: 'unknown_peer' }, 400);
    deps.vault().setSourcePeer(parsed.data.peer_id);
    return c.json({ ok: true });
  });

  app.post('/api/v1/vault/import/infisical/:code', async (c) => {
    const code = c.req.param('code');
    const resolved = await resolveInfisical(code, deps.getCatalogInfisical(code));
    if (!resolved.ok) return c.json({ error: resolved.code, message: resolved.message }, resolved.code === 'no_mapping' ? 404 : 502);
    return handle(c, async () => {
      const vault = deps.vault();
      const names = await vault.setEntries(resolved.secrets);
      vault.setBindings(code, [...vault.bindingsFor(code), ...names]);
      logger.info({ code, count: names.length }, 'imported Infisical values into vault');
      return { ok: true, imported: names };
    });
  });

  return app;
}

async function handle(
  c: { json: (body: unknown, status?: 400) => Response },
  run: () => Promise<unknown>,
): Promise<Response> {
  try {
    return c.json(await run());
  } catch (error) {
    if (error instanceof VaultError) return c.json({ error: error.code, message: error.message }, 400);
    throw error;
  }
}
