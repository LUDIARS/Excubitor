/**
 * Vault の管理 API (loopback の本体のみ。拠点間リスナーには載せない)。
 *
 *   GET    /api/v1/vault                           名前・更新日時・紐付け・取得元 (値は返さない)
 *   PUT    /api/v1/vault/entries/:name             { value }  値を登録 / 差し替え
 *   DELETE /api/v1/vault/entries/:name
 *   PUT    /api/v1/vault/bindings/:code            { names }  サービスが使う環境変数
 *   PUT    /api/v1/vault/overrides/:code           { names }  拠点の上書き: 本社の値より優先する環境変数 (空で外す)
 *   PUT    /api/v1/vault/source                    { peer_id } 拠点: 値を受け取る本社 (null で本社扱い)
 *
 * 平文を返す口は作らない。値を確かめたいときは差し替える。
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { createNamedLogger } from '../shared/logger.js';
import { getPeer } from '../federation/store.js';
import { VaultError, type Vault } from './vault.js';

const logger = createNamedLogger('excubitor.vault.router');

const ValueSchema = z.object({ value: z.string() });
const BindingsSchema = z.object({ names: z.array(z.string()).max(256) });
const SourceSchema = z.object({ peer_id: z.string().min(1).nullable() });
const ProjectSchema = z.object({ name: z.string().trim().min(1).max(128) });

export interface VaultRouterDeps {
  vault: () => Vault;
  /** 取得元に指定できるピアか (既定: 登録済み)。 */
  peerExists?: (id: string) => boolean;
}

export function buildVaultRouter(deps: VaultRouterDeps): Hono {
  const app = new Hono();
  const peerExists = deps.peerExists ?? ((id: string) => getPeer(id) !== null);
  app.get('/api/v1/vault', (c) => c.json(deps.vault().status()));

  const scoped = (project: string | undefined): Vault => {
    const vault = deps.vault();
    if (project === undefined) return vault;
    if (!vault.status().projects.some((p) => p.id === project)) throw new VaultError('invalid_project', 'unknown project Vault');
    return vault.forProject(project);
  };

  app.put('/api/v1/vault/projects/:id', async (c) => {
    const parsed = ProjectSchema.safeParse(await c.req.json().catch(() => null));
    const id = c.req.param('id');
    if (!parsed.success || id.length > 128 || !id.trim()) return c.json({ error: 'invalid_body' }, 400);
    deps.vault().registerProject(id, parsed.data.name);
    return c.json({ ok: true });
  });

  app.put('/api/v1/vault/entries/:name', async (c) => {
    const parsed = ValueSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
    return handle(c, async () => {
      await scoped(c.req.query('project')).setEntry(c.req.param('name'), parsed.data.value);
      logger.info({ name: c.req.param('name') }, 'vault entry saved');
      return { ok: true };
    });
  });

  app.delete('/api/v1/vault/entries/:name', (c) => handle(c, async () => {
    const existed = scoped(c.req.query('project')).deleteEntry(c.req.param('name'));
    if (existed) logger.info({ name: c.req.param('name') }, 'vault entry deleted');
    return existed ? c.json({ ok: true }) : c.json({ error: 'not_found' }, 404);
  }));

  app.put('/api/v1/vault/bindings/:code', async (c) => {
    const parsed = BindingsSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
    return handle(c, async () => {
      const project = c.req.query('project');
      if (project !== undefined) deps.vault().setProjectBindings(project, c.req.param('code'), parsed.data.names);
      else deps.vault().setBindings(c.req.param('code'), parsed.data.names);
      return { ok: true };
    });
  });

  app.put('/api/v1/vault/overrides/:code', async (c) => {
    const parsed = BindingsSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
    return handle(c, async () => {
      deps.vault().setOverrides(c.req.param('code'), parsed.data.names);
      logger.info({ code: c.req.param('code'), names: parsed.data.names }, 'vault site overrides saved');
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

  return app;
}

async function handle(
  c: { json: (body: unknown, status?: 400) => Response },
  run: () => Promise<unknown>,
): Promise<Response> {
  try {
    const result = await run();
    return result instanceof Response ? result : c.json(result);
  } catch (error) {
    if (error instanceof VaultError) return c.json({ error: error.code, message: error.message }, 400);
    throw error;
  }
}
