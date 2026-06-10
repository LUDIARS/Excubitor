/**
 * リリースビルド API。
 *
 * - GET  /api/v1/releases             マニフェスト一覧 (releases/*.yaml)
 * - GET  /api/v1/releases/:name       マニフェスト詳細 + dry-run plan (repo 解決 + git meta、 ビルドしない)
 * - POST /api/v1/releases/:name/build バンドルを実ビルドして zip 化
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { Catalog } from '../catalog/loader.js';
import { listReleaseManifests, loadReleaseManifest } from './manifest.js';
import { planRelease } from './plan.js';
import { readGitMeta } from './git-meta.js';
import { buildRelease } from './orchestrator.js';

const BuildBodySchema = z.object({
  version: z.string().optional(),
  skipBuild: z.boolean().optional(),
  skipInstall: z.boolean().optional(),
  skipArchive: z.boolean().optional(),
});

/** name → マニフェストパス。 無ければ null。 */
function manifestPathOf(name: string): string | null {
  return listReleaseManifests().find((m) => m.name === name)?.path ?? null;
}

export function buildReleaseRouter(getCatalog: () => Catalog | null): Hono {
  const app = new Hono();

  app.get('/api/v1/releases', (c) => {
    const manifests = listReleaseManifests().map((m) => {
      try {
        const manifest = loadReleaseManifest(m.path);
        return {
          name: manifest.name,
          display_name: manifest.display_name ?? manifest.name,
          description: manifest.description ?? null,
          primary: manifest.primary,
          components: manifest.components.map((comp) => ({ code: comp.code, role: comp.role })),
          error: null,
        };
      } catch (err) {
        return { name: m.name, error: (err as Error).message };
      }
    });
    return c.json({ releases: manifests });
  });

  app.get('/api/v1/releases/:name', async (c) => {
    const name = c.req.param('name');
    const path = manifestPathOf(name);
    if (!path) return c.json({ error: 'not_found' }, 404);
    let manifest;
    try {
      manifest = loadReleaseManifest(path);
    } catch (err) {
      return c.json({ error: 'invalid_manifest', message: (err as Error).message }, 400);
    }
    const plan = planRelease(manifest, getCatalog());
    const components = await Promise.all(
      plan.components.map(async (rc) => ({
        code: rc.component.code,
        role: rc.component.role,
        repoDir: rc.repoDir || null,
        bundleSubdir: rc.bundleSubdir,
        git: await readGitMeta(rc.repoDir),
      })),
    );
    return c.json({ manifest, plan: { errors: plan.errors, components } });
  });

  app.post('/api/v1/releases/:name/build', async (c) => {
    const name = c.req.param('name');
    const path = manifestPathOf(name);
    if (!path) return c.json({ error: 'not_found' }, 404);
    let manifest;
    try {
      manifest = loadReleaseManifest(path);
    } catch (err) {
      return c.json({ error: 'invalid_manifest', message: (err as Error).message }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = BuildBodySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_body', detail: parsed.error.flatten() }, 400);

    try {
      const result = await buildRelease(manifest, { catalog: getCatalog(), ...parsed.data });
      return c.json(result, result.ok ? 200 : 500);
    } catch (err) {
      return c.json({ error: 'build_failed', message: (err as Error).message }, 500);
    }
  });

  return app;
}
