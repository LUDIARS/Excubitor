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
import { type Catalog, type Tier, TIER_ORDER } from '../catalog/loader.js';
import { getLaunchProfile, saveLaunchProfile } from './profile.js';
import { buildPlanProjects } from './grouping.js';
import { runPreflight } from './preflight.js';
import { startSelection, stopSelection } from './orchestrator.js';
import { usesCorpusByCode, setCorpusPref } from './corpus-prefs.js';

const SaveProfileSchema = z.object({
  selection: z.array(z.string()),
  auto_launch: z.boolean().optional(),
});

const CodesSchema = z.object({
  codes: z.array(z.string()).optional(),
});

/** service_instances から code→state の map を作る。 */
/** `?tier=saas,infra` を Tier の Set に解釈する (未指定/不正は undefined = 全 tier)。 */
function parseTierFilter(raw: string | undefined): Set<Tier> | undefined {
  if (!raw) return undefined;
  const valid = new Set(TIER_ORDER);
  const tiers = raw.split(',').map((t) => t.trim()).filter((t): t is Tier => valid.has(t as Tier));
  return tiers.length > 0 ? new Set(tiers) : undefined;
}

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
    // SaaS ランチャーは `?tier=saas,infra` で絞り込む。 未指定なら全 tier。
    const filterTiers = parseTierFilter(c.req.query('tier'));
    const catalog = getCatalog();
    const projects = buildPlanProjects(
      catalog.services, stateByCode(), new Set(profile.selection), filterTiers, usesCorpusByCode(catalog),
    );
    return c.json({
      profile: {
        configured: profile.configured,
        auto_launch: profile.autoLaunch,
        selection: profile.selection,
        updated_at: profile.updatedAt,
      },
      tiers: TIER_ORDER,
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

  // Corpus 利用設定の保存 (req3)。 usesCorpus=null で catalog デフォルトに戻す。
  app.put('/api/v1/services/:code/corpus-pref', async (c) => {
    const code = c.req.param('code');
    if (!getCatalog().services.some((s) => s.code === code)) return c.json({ error: 'not_found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { uses_corpus?: boolean | null };
    const v = body.uses_corpus;
    if (v !== true && v !== false && v !== null) return c.json({ error: 'invalid_body' }, 400);
    setCorpusPref(code, v);
    return c.json({ ok: true, code, uses_corpus: v });
  });

  // 既存 Catalog 画面用 (project 別グルーピング)。frontend api.ts fetchProjects が叩く。
  // git / version / last_seen は service_instances から補完してカードに詳細を出す (req6)。
  app.get('/api/v1/projects', (c) => {
    const profile = getLaunchProfile();
    const catalog = getCatalog();
    const projects = buildPlanProjects(
      catalog.services, stateByCode(), new Set(profile.selection), undefined, usesCorpusByCode(catalog),
    );
    const detail = instanceDetailByCode();
    return c.json({
      projects: projects.map((p) => ({
        project_code: p.project_code,
        project_name: p.project_code,
        components: p.services.map((s) => {
          const d = detail.get(s.code);
          return {
            code: s.code,
            name: s.name,
            component: s.component,
            runtime: s.runtime,
            tier: s.tier,
            state: s.state,
            port: s.port,
            git: {
              branch: d?.git_branch ?? null,
              hash: d?.git_hash ?? null,
              dirty: d?.git_dirty ?? null,
            },
            package_version: d?.package_version ?? null,
            monitor_only: s.monitor_only,
            has_vestigium: s.has_vestigium,
            log_path: s.log_path,
            autostart: s.autostart,
            start_script: s.start_script,
            uses_corpus: s.uses_corpus,
            host: null,
            last_seen_at: d?.last_seen_at ?? null,
            docker_id: d?.docker_id ?? null,
          };
        }),
      })),
    });
  });

  return app;
}

interface InstanceDetail {
  git_branch: string | null;
  git_hash: string | null;
  git_dirty: boolean | null;
  package_version: string | null;
  last_seen_at: number | null;
  docker_id: string | null;
}

/** service_instances から code→詳細 (git/version/last_seen) を引く。 */
function instanceDetailByCode(): Map<string, InstanceDetail> {
  const rows = db().all(sql`
    SELECT s.code AS code, si.git_branch, si.git_hash, si.git_dirty,
           si.package_version, si.last_seen_at, si.docker_id
    FROM services s
    LEFT JOIN service_instances si ON si.service_id = s.id
    WHERE s.is_active = 1
  `) as Array<Record<string, unknown>>;
  const map = new Map<string, InstanceDetail>();
  for (const r of rows) {
    map.set(r.code as string, {
      git_branch: (r.git_branch as string | null) ?? null,
      git_hash: (r.git_hash as string | null) ?? null,
      git_dirty: r.git_dirty === null || r.git_dirty === undefined ? null : Boolean(r.git_dirty),
      package_version: (r.package_version as string | null) ?? null,
      last_seen_at: (r.last_seen_at as number | null) ?? null,
      docker_id: (r.docker_id as string | null) ?? null,
    });
  }
  return map;
}
