/**
 * Vault の管理 API (loopback の本体のみ。拠点間リスナーには載せない)。
 *
 *   GET    /api/v1/vault                           名前・更新日時・紐付け・取得元 (値は返さない)
 *   PUT    /api/v1/vault/entries/:name             { value }  値を登録 / 差し替え
 *   DELETE /api/v1/vault/entries/:name
 *   PUT    /api/v1/vault/bindings/:code            { names }  サービスが使う環境変数
 *   PUT    /api/v1/vault/source                    { peer_id } 拠点: 値を受け取る本社 (null で本社扱い)
 *   POST   /api/v1/vault/import/infisical/:code    Infisical の値を Vault へ移し、紐付けに足す
 *   POST   /api/v1/vault/import/infisical          { dry_run?, environment? } Infisical の全 project を一括で移す
 *
 * 平文を返す口は作らない。値を確かめたいときは差し替える。
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { fetchProjectSecrets, listProjects, readIdentity } from '../secrets/infisical.js';
import type { ServiceInfisical } from '../secrets/config-store.js';
import { createNamedLogger } from '../shared/logger.js';
import { getPeer } from '../federation/store.js';
import { VaultError, type Vault } from './vault.js';
import { importAllFromInfisical, importServiceValues, type BulkImportOptions, type BulkImportResult } from './infisical-bulk-import.js';
import { resolveInfisicalForImport } from './infisical-import-resolve.js';

const logger = createNamedLogger('excubitor.vault.router');

const ValueSchema = z.object({ value: z.string() });
const BindingsSchema = z.object({ names: z.array(z.string()).max(256) });
const SourceSchema = z.object({ peer_id: z.string().min(1).nullable() });
const BulkImportSchema = z.object({ dry_run: z.boolean().optional(), environment: z.string().min(1).max(64).optional() });
const ProjectSchema = z.object({ name: z.string().trim().min(1).max(128) });

export interface VaultRouterDeps {
  vault: () => Vault;
  getCatalogInfisical: (code: string) => ServiceInfisical | undefined;
  /** 取得元に指定できるピアか (既定: 登録済み)。 */
  peerExists?: (id: string) => boolean;
  resolveInfisical?: typeof resolveInfisicalForImport;
  /** Infisical マッピングを持つサービス (config store 優先 / catalog fallback で解決済み)。 */
  listInfisicalServices?: () => Array<{ code: string; mapping: ServiceInfisical }>;
  /** 一括移行の実行 (既定: Excubitor の machine identity で Infisical を引く)。identity が無ければ null。 */
  bulkImport?: (options: BulkImportOptions) => Promise<BulkImportResult | null>;
}

export function buildVaultRouter(deps: VaultRouterDeps): Hono {
  const app = new Hono();
  const peerExists = deps.peerExists ?? ((id: string) => getPeer(id) !== null);
  const resolveInfisical = deps.resolveInfisical ?? resolveInfisicalForImport;
  const bulkImport = deps.bulkImport ?? (async (options: BulkImportOptions) => {
    const identity = readIdentity();
    if (!identity) return null;
    const services = deps.listInfisicalServices?.() ?? [];
    return importAllFromInfisical({ vault: deps.vault(), identity, services, listProjects, fetchSecrets: fetchProjectSecrets }, options);
  });

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

  app.put('/api/v1/vault/source', async (c) => {
    const parsed = SourceSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
    if (parsed.data.peer_id && !peerExists(parsed.data.peer_id)) return c.json({ error: 'unknown_peer' }, 400);
    deps.vault().setSourcePeer(parsed.data.peer_id);
    return c.json({ ok: true });
  });

  app.post('/api/v1/vault/import/infisical', async (c) => {
    const parsed = BulkImportSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
    try {
      const result = await bulkImport({ dryRun: parsed.data.dry_run, environment: parsed.data.environment });
      if (!result) return c.json({ error: 'no_identity', message: 'Excubitor has no Infisical machine identity (INFISICAL_SITE_URL / CLIENT_ID / CLIENT_SECRET)' }, 400);
      return c.json({ ok: true, ...result });
    } catch (error) {
      // project 一覧が取れないなど、Infisical 側の失敗。個々のサービス/project の失敗は結果の error に入る。
      return c.json({ error: 'infisical_failed', message: (error as Error).message }, 502);
    }
  });

  app.post('/api/v1/vault/import/infisical/:code', async (c) => {
    const code = c.req.param('code');
    const resolved = await resolveInfisical(code, deps.getCatalogInfisical(code));
    if (!resolved.ok) return c.json({ error: resolved.code, message: resolved.message }, resolved.code === 'no_mapping' ? 404 : 502);
    return handle(c, async () => {
      const vault = deps.vault();
      if (!vault.status().projects.some((p) => p.id === resolved.projectId)) vault.registerProject(resolved.projectId);
      const result = await importServiceValues(vault, code, resolved.secrets, { projectId: resolved.projectId });
      logger.info({ code, imported: result.imported.length, unchanged: result.unchanged.length, conflicts: result.conflicts }, 'imported Infisical values into vault');
      return { ok: true, ...result };
    });
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
