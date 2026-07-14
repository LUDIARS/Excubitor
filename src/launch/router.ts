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
import { updateServiceCatalogInfo } from '../catalog/editor.js';
import { createNamedLogger } from '../shared/logger.js';
import { writeDiagnostic } from '../shared/diagnostic-log.js';
import { getLaunchProfile, saveLaunchProfile } from './profile.js';
import { buildPlanProjects } from './grouping.js';
import { runPreflight } from './preflight.js';
import { startSelection, stopSelection } from './orchestrator.js';
import { expandWithDependencies } from './order.js';
import { usesCorpusByCode, setCorpusPref } from './corpus-prefs.js';
import type { DowntimeSummaryReader } from '../scanner/downtime-reader.js';
import {
  getServiceMap,
  setServiceMap,
  resolveServiceInfisical,
  type ServiceInfisical,
} from '../secrets/config-store.js';
import { resolveInjectEnv } from '../process/inject.js';
import { requiredEnvKeysForService, validateStartupEnv } from '../process/startup-env.js';

const SaveProfileSchema = z.object({
  selection: z.array(z.string()),
  auto_launch: z.boolean().optional(),
});

const CodesSchema = z.object({
  codes: z.array(z.string()).optional(),
});

const CatalogInfoSchema = z.object({
  project_code: z.string().trim().min(1).max(80).nullable().optional(),
  subdomain: z.string().trim().max(120).nullable().optional(),
  frontend_url: z.string().trim().max(300).nullable().optional(),
});

const ServiceEnvConfigSchema = z.object({
  project_id: z.string().trim().max(200).nullable().optional(),
  environment: z.string().trim().max(80).default('dev'),
  inject: z.boolean().default(true),
  prefix: z.string().trim().max(120).default(''),
  include: z.array(z.string().trim().min(1)).optional(),
  exclude: z.array(z.string().trim().min(1)).optional(),
  required_env: z.array(z.string().trim().min(1)).optional(),
});

const logger = createNamedLogger('excubitor.launch.router');

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
    SELECT
      s.code AS code,
      CASE
        WHEN lh.ok = 1 THEN 'running'
        WHEN lh.ok = 0 THEN 'stopped'
        ELSE si.state
      END AS state
    FROM services s
    LEFT JOIN service_instances si ON si.service_id = s.id
    LEFT JOIN liveness_history lh ON lh.id = (
      SELECT lh2.id
      FROM liveness_history lh2
      WHERE lh2.service_instance_id = si.id
      ORDER BY lh2.probed_at DESC, lh2.id DESC
      LIMIT 1
    )
    WHERE s.is_active = 1
  `) as Array<{ code: string; state: string | null }>;
  const map = new Map<string, string>();
  for (const r of rows) map.set(r.code, r.state ?? 'unknown');
  return map;
}

export function buildLaunchRouter(
  getCatalog: () => Catalog,
  readDowntimeSummaries: DowntimeSummaryReader,
  onCatalogChanged?: (reason: string) => Promise<number>,
): Hono {
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
    const catalog = getCatalog();
    const report = await runPreflight(catalog.services, expandWithDependencies(catalog.services, codes));
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
  app.get('/api/v1/services/:code/env-config', async (c) => {
    const code = c.req.param('code');
    const svc = getCatalog().services.find((s) => s.code === code);
    if (!svc) return c.json({ error: 'not_found' }, 404);
    const services = getServiceMap();
    const override = services[code] ?? null;
    return c.json({
      code,
      catalog: svc.infisical ?? null,
      override,
      effective: resolveServiceInfisical(code, svc.infisical) ?? null,
      required_env: requiredEnvKeysForService(svc),
      status: await serviceEnvStatus(svc),
    });
  });

  app.put('/api/v1/services/:code/env-config', async (c) => {
    const code = c.req.param('code');
    const svc = getCatalog().services.find((s) => s.code === code);
    if (!svc) return c.json({ error: 'not_found' }, 404);
    const body = await c.req.json().catch(() => ({}));
    const parsed = ServiceEnvConfigSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_body', detail: parsed.error.flatten() }, 400);

    const services = getServiceMap();
    const projectId = parsed.data.project_id?.trim() ?? '';
    if (!projectId) {
      delete services[code];
    } else {
      services[code] = normalizeServiceInfisical({
        project_id: projectId,
        environment: parsed.data.environment || 'dev',
        inject: parsed.data.inject,
        prefix: parsed.data.prefix ?? '',
        include: parsed.data.include,
        exclude: parsed.data.exclude,
        required_env: parsed.data.required_env,
      });
    }
    setServiceMap(services);

    return c.json({
      ok: true,
      code,
      override: services[code] ?? null,
      effective: resolveServiceInfisical(code, svc.infisical) ?? null,
      required_env: requiredEnvKeysForService(svc),
      status: await serviceEnvStatus(svc),
    });
  });

  app.get('/api/v1/projects', async (c) => {
    const profile = getLaunchProfile();
    const catalog = getCatalog();
    const projects = buildPlanProjects(
      catalog.services, stateByCode(), new Set(profile.selection), undefined, usesCorpusByCode(catalog),
    );
    const detail = instanceDetailByCode();
    const downtimeByCode = await readDowntimeSummaries(
      projects.flatMap((p) => p.services.map((s) => s.code)),
      24 * 60,
    );
    const view = projects.map((p) => ({
        project_code: p.project_code,
        project_name: p.project_code,
        components: p.services.map((s) => {
          const d = detail.get(s.code);
          return {
            code: s.code,
            name: s.name,
            project_code: s.project_code,
            disabled: s.disabled,
            description: s.description,
            component: s.component,
            runtime: s.runtime,
            tier: s.tier,
            state: s.state,
            port: s.port,
            frontend_port: s.frontend_port,
            backend_port: s.backend_port,
            ports: s.ports,
            frontend_url: s.frontend_url,
            subdomain: s.subdomain,
            domain: s.domain,
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
            allow_hot_reload: s.allow_hot_reload,
            start_script: s.start_script,
            uses_corpus: s.uses_corpus,
            host: null,
            last_seen_at: d?.last_seen_at ?? null,
            docker_id: d?.docker_id ?? null,
            health_ok: d?.health_ok ?? null,
            health_reason: d?.health_reason ?? null,
            health_detail: d?.health_detail ?? null,
            health_checked_at: d?.health_checked_at ?? null,
            downtime_24h: downtimeByCode.get(s.code) ?? null,
          };
        }),
      }));
    view.sort(compareProjectViews);
    return c.json({ projects: view });
  });

  app.put('/api/v1/services/:code/catalog-info', async (c) => {
    const code = c.req.param('code');
    logger.info({ code }, 'catalog info update requested');
    writeDiagnostic('catalogInfo.requested', { code });
    if (!getCatalog().services.some((s) => s.code === code)) return c.json({ error: 'not_found' }, 404);
    const body = await c.req.json().catch(() => ({}));
    const parsed = CatalogInfoSchema.safeParse(body);
    if (!parsed.success) {
      logger.warn({ code, detail: parsed.error.flatten() }, 'catalog info update invalid body');
      writeDiagnostic('catalogInfo.invalidBody', { code, detail: parsed.error.flatten() });
      return c.json({ error: 'invalid_body', detail: parsed.error.flatten() }, 400);
    }

    try {
      const patch: Parameters<typeof updateServiceCatalogInfo>[1] = {};
      const hasProjectCode = Object.prototype.hasOwnProperty.call(parsed.data, 'project_code');
      const hasSubdomain = Object.prototype.hasOwnProperty.call(parsed.data, 'subdomain');
      const hasFrontendUrl = Object.prototype.hasOwnProperty.call(parsed.data, 'frontend_url');
      const projectCode = hasProjectCode ? parsed.data.project_code ?? null : undefined;
      const subdomain = hasSubdomain ? cleanSubdomain(parsed.data.subdomain) : undefined;
      const frontendUrl = hasFrontendUrl ? cleanFrontendUrl(parsed.data.frontend_url) : undefined;
      const domain = subdomain === undefined ? undefined : subdomain ? `${subdomain}\${DOMAIN_ROOT}` : null;
      if (hasProjectCode) patch.project_code = projectCode ?? null;
      if (hasSubdomain) {
        patch.subdomain = subdomain ?? null;
        patch.domain = domain ?? null;
      }
      if (hasFrontendUrl) patch.frontend_url = frontendUrl ?? null;
      logger.info(
        { code, project_code: projectCode, subdomain, frontend_url: frontendUrl, domain },
        'writing catalog info',
      );
      writeDiagnostic('catalogInfo.write.start', {
        code,
        project_code: projectCode,
        subdomain,
        frontend_url: frontendUrl,
        domain,
      });
      const result = updateServiceCatalogInfo(code, patch);
      await onCatalogChanged?.('catalog info edit');
      logger.info({ code, updated: result.updated }, 'catalog info update complete');
      writeDiagnostic('catalogInfo.write.complete', { code, updated: result.updated });
      return c.json({ ok: true, ...result });
    } catch (err) {
      logger.error({ code, err: (err as Error).stack ?? (err as Error).message }, 'catalog info update failed');
      writeDiagnostic('catalogInfo.write.failed', { code, err: (err as Error).stack ?? (err as Error).message });
      return c.json({ error: 'catalog_info_update_failed', message: (err as Error).message }, 400);
    }
  });

  return app;
}

function normalizeList(input: string[] | undefined): string[] | undefined {
  if (!input) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    const value = raw.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out.length > 0 ? out : undefined;
}

function normalizeServiceInfisical(input: ServiceInfisical): ServiceInfisical {
  return {
    project_id: input.project_id.trim(),
    environment: input.environment.trim() || 'dev',
    inject: input.inject,
    prefix: input.prefix?.trim() ?? '',
    include: normalizeList(input.include),
    exclude: normalizeList(input.exclude),
    required_env: normalizeList(input.required_env),
  };
}

async function serviceEnvStatus(svc: Catalog['services'][number]): Promise<{
  ready: boolean;
  required: string[];
  missing: string[];
  resolvedKeys: number | null;
  error: string | null;
}> {
  const required = requiredEnvKeysForService(svc);
  try {
    const env = await resolveInjectEnv(svc);
    const validation = validateStartupEnv(svc, env);
    return {
      ready: validation.ready,
      required: validation.required,
      missing: validation.missing,
      resolvedKeys: Object.keys(env).length,
      error: null,
    };
  } catch (err) {
    return {
      ready: false,
      required,
      missing: required,
      resolvedKeys: null,
      error: (err as Error).message,
    };
  }
}

function cleanSubdomain(input: string | null | undefined): string | null {
  const raw = input?.trim().toLowerCase();
  if (!raw) return null;
  if (raw.includes('://') || raw.includes('/') || raw.includes(',')) {
    throw new Error('subdomain must be a hostname label');
  }
  const label = raw.replace(/\.+$/, '');
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) {
    throw new Error('subdomain must be a hostname label');
  }
  return label;
}

function cleanFrontendUrl(input: string | null | undefined): string | null {
  const raw = input?.trim();
  if (!raw) return null;
  const candidate = raw.includes('://') ? raw : `https://${raw}`;
  const url = new URL(candidate);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('frontend_url must be an http or https URL');
  }
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

interface InstanceDetail {
  git_branch: string | null;
  git_hash: string | null;
  git_dirty: boolean | null;
  package_version: string | null;
  last_seen_at: number | null;
  docker_id: string | null;
  health_ok: boolean | null;
  health_reason: string | null;
  health_detail: string | null;
  health_checked_at: number | null;
}

interface ProjectView {
  project_code: string;
  project_name: string;
  components: Array<{
    code: string;
    name: string;
    project_code: string;
    subdomain: string | null;
    frontend_url: string | null;
    domain: string | null;
    last_seen_at: number | null;
  }>;
}

function compareProjectViews(a: ProjectView, b: ProjectView): number {
  const ac = projectCatalogInfoComplete(a) ? 0 : 1;
  const bc = projectCatalogInfoComplete(b) ? 0 : 1;
  if (ac !== bc) return ac - bc;
  const al = projectLastSeenAt(a);
  const bl = projectLastSeenAt(b);
  if (al !== bl) return bl - al;
  return projectDisplayName(a).localeCompare(projectDisplayName(b));
}

function projectCatalogInfoComplete(project: ProjectView): boolean {
  const frontend = project.components.find((c) => c.frontend_url || c.domain || c.subdomain);
  if (!frontend) return false;
  return Boolean(frontend.project_code && frontend.subdomain && frontend.domain);
}

function projectLastSeenAt(project: ProjectView): number {
  return Math.max(0, ...project.components.map((c) => c.last_seen_at ?? 0));
}

function projectDisplayName(project: ProjectView): string {
  const named = project.components.find((c) => c.name && c.name.toLowerCase() !== c.code.toLowerCase())?.name;
  return named ?? project.project_name ?? project.project_code;
}

/** service_instances から code→詳細 (git/version/last_seen) を引く。 */
function instanceDetailByCode(): Map<string, InstanceDetail> {
  const rows = db().all(sql`
    SELECT s.code AS code, si.git_branch, si.git_hash, si.git_dirty,
           si.package_version, si.last_seen_at, si.docker_id,
           lh.ok AS health_ok, lh.probed_at AS health_checked_at, lh.detail AS health_detail_raw
    FROM services s
    LEFT JOIN service_instances si ON si.service_id = s.id
    LEFT JOIN liveness_history lh ON lh.id = (
      SELECT lh2.id
      FROM liveness_history lh2
      WHERE lh2.service_instance_id = si.id
      ORDER BY lh2.probed_at DESC, lh2.id DESC
      LIMIT 1
    )
    WHERE s.is_active = 1
  `) as Array<Record<string, unknown>>;
  const map = new Map<string, InstanceDetail>();
  for (const r of rows) {
    const health = parseHealthDetail(r.health_detail_raw);
    map.set(r.code as string, {
      git_branch: (r.git_branch as string | null) ?? null,
      git_hash: (r.git_hash as string | null) ?? null,
      git_dirty: r.git_dirty === null || r.git_dirty === undefined ? null : Boolean(r.git_dirty),
      package_version: (r.package_version as string | null) ?? null,
      last_seen_at: (r.last_seen_at as number | null) ?? null,
      docker_id: (r.docker_id as string | null) ?? null,
      health_ok: r.health_ok === null || r.health_ok === undefined ? null : Boolean(r.health_ok),
      health_reason: health.reason,
      health_detail: health.detail,
      health_checked_at: (r.health_checked_at as number | null) ?? null,
    });
  }
  return map;
}

function parseHealthDetail(raw: unknown): { reason: string | null; detail: string | null } {
  if (raw === null || raw === undefined) return { reason: null, detail: null };
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      return {
        reason: typeof record.reason === 'string' ? record.reason : null,
        detail: typeof record.detail === 'string' ? record.detail : null,
      };
    }
  } catch {
    return { reason: null, detail: String(raw) };
  }
  return { reason: null, detail: String(raw) };
}
