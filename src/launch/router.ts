/**
 * ランチャー API (`/api/v1/launch/*` + `/api/v1/projects`)。
 *
 * 起動セット (どのサービスを立ち上げるか) の選択・保存・preflight・一括起動/停止。
 * 「起動したら何を立ち上げるかを設定する画面」 (2026-06-04 ユーザ指示) の backend。
 *
 * 現在の catalog は index.ts が保持しているため、 getCatalog() を注入してもらう。
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { Catalog } from '../catalog/loader.js';
import { getLaunchProfile, saveLaunchProfile } from './profile.js';
import { buildPlanProjects } from './grouping.js';
import { runPreflight } from './preflight.js';
import { startSelection, stopSelection } from './orchestrator.js';

const SaveProfileSchema = z.object({
  selection: z.array(z.string()),
  auto_launch: z.boolean().optional(),
});

const CodesSchema = z.object({
  codes: z.array(z.string()).optional(),
});

/** service_instances から code→state の map を作る。 */
function stateByCode(): Map<string, string> {
  const rows = db().all(sql`
    SELECT s.code AS code, si.state AS state
    FROM services s
    LEFT JOIN service_instances si ON si.service_id = s.id
    WHERE s.is_active = 1
  `) as Array<{ code: string; state: string | null }>;
  const map = new Map<string, string>();
  for (const r of rows) map.set(r.code, r.state ?? 'unknown');
  return map;
}

export function buildLaunchRouter(getCatalog: () => Catalog): Hono {
  const app = new Hono();

  // 起動セット選択画面の plan (profile + project 別サービス)。
  app.get('/api/v1/launch/plan', (c) => {
    const profile = getLaunchProfile();
    const projects = buildPlanProjects(getCatalog().services, stateByCode(), new Set(profile.selection));
    return c.json({
      profile: {
        configured: profile.configured,
        auto_launch: profile.autoLaunch,
        selection: profile.selection,
        updated_at: profile.updatedAt,
      },
      projects,
    });
  });

  // 起動セットの保存 (= ウィザード完了 / 設定変更)。
  app.put('/api/v1/launch/profile', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = SaveProfileSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_body', detail: parsed.error.flatten() }, 400);
    const profile = saveLaunchProfile({
      selection: parsed.data.selection,
      autoLaunch: parsed.data.auto_launch,
      configured: true,
    });
    return c.json({ ok: true, profile });
  });

  // 起動前チェック (codes 省略時は保存済み selection)。
  app.post('/api/v1/launch/preflight', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = CodesSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
    const codes = parsed.data.codes ?? getLaunchProfile().selection;
    const report = await runPreflight(getCatalog().services, codes);
    return c.json(report);
  });

  // 一括起動 (codes 省略時は保存済み selection)。
  app.post('/api/v1/launch/start', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = CodesSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
    const codes = parsed.data.codes ?? getLaunchProfile().selection;
    const actor = c.req.header('x-excubitor-actor') ?? 'launcher';
    const result = await startSelection(getCatalog(), codes, { actor });
    return c.json(result);
  });

  // 一括停止。
  app.post('/api/v1/launch/stop', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = CodesSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
    const codes = parsed.data.codes ?? getLaunchProfile().selection;
    const actor = c.req.header('x-excubitor-actor') ?? 'launcher';
    const results = await stopSelection(getCatalog(), codes, actor);
    return c.json({ results });
  });

  // 既存 Catalog 画面用 (project 別グルーピング)。frontend api.ts fetchProjects が叩く。
  app.get('/api/v1/projects', (c) => {
    const profile = getLaunchProfile();
    const projects = buildPlanProjects(getCatalog().services, stateByCode(), new Set(profile.selection));
    return c.json({
      projects: projects.map((p) => ({
        project_code: p.project_code,
        project_name: p.project_code,
        components: p.services.map((s) => ({
          code: s.code,
          name: s.name,
          component: s.component,
          runtime: s.runtime,
          state: s.state,
          port: s.port,
          git: { branch: null, hash: null, dirty: null },
          package_version: null,
          monitor_only: s.monitor_only,
          has_vestigium: s.has_vestigium,
          log_path: s.log_path,
          autostart: s.autostart,
          host: null,
          last_seen_at: null,
          docker_id: null,
        })),
      })),
    });
  });

  return app;
}
