/**
 * Observability layer の bootstrap + router.
 *
 * Excubitor から雁E��E(2026-05-17). Concordia の startBackend() から `bootObservability()`
 * を呼ぶと:
 *   - catalog 読み込み + DB 同期
 *   - default error rules seed
 *   - process bridge (spawn 子�Eロセスの stdout めElog bus へ流す)
 *   - error detector (log bus を購読してパターン検知 ↁEerror_tasks 投�E)
 *   - scanner loop (docker / git / package version の周期スキャン)
 *   - catalog watcher (services.yaml 変更検知して冁Esync)
 *   - autostart 実衁E
 *   - HTTP router を返す (app.ts でマウンチE
 */

import { Hono } from 'hono';
import { sql as drizzleSql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createNamedLogger } from './shared/logger.js';
import { z } from 'zod';

import { db } from './db/client.js';
import { loadCatalog, type Catalog, type Service } from './catalog/loader.js';
import { syncCatalog } from './catalog/sync.js';
import { watchCatalog } from './catalog/watcher.js';
import { startScannerLoop } from './scanner/loop.js';
import { syncDockerInstances } from './scanner/sync.js';
import { controlService } from './control/manager.js';
import { runAutostart } from './process/autostart.js';
import { listRunningProcesses } from './process/manager.js';
import { attachProcessBridge } from './log/process-bridge.js';
import { startFileTail, type FileTailHandle } from './log/file-tail.js';
import { startErrorDetector, setCatalogProvider } from './log/error-detector.js';
import { seedDefaultRules } from './auto_fix/seed.js';
import { runAutoFix } from './auto_fix/runner.js';
import { runInvestigation } from './auto_fix/investigate.js';
import { buildReviewsRouter } from './reviews/router.js';

const logger = createNamedLogger('concordia.observability');

const ControlBodySchema = z.object({
  action: z.enum(['start', 'stop', 'restart']),
});

interface ObservabilityHandle {
  router: Hono;
  shutdown: () => Promise<void>;
}

let currentCatalog: Catalog | null = null;

function findService(code: string): Service | undefined {
  return currentCatalog?.services.find((s) => s.code === code);
}

export async function bootObservability(): Promise<ObservabilityHandle> {
  // boot: catalog ↁEDB sync
  currentCatalog = loadCatalog();
  const sync = await syncCatalog(currentCatalog);
  logger.info(
    { upserted: sync.upserted, deactivated: sync.deactivated, total: currentCatalog.services.length },
    'catalog synced',
  );

  await seedDefaultRules();
  attachProcessBridge();
  const fileTailHandle: FileTailHandle = startFileTail(currentCatalog);
  setCatalogProvider(() => currentCatalog!);
  await startErrorDetector();
  const scannerHandle = startScannerLoop(currentCatalog);
  const watcherHandle = watchCatalog('catalog/services.yaml', async () => {
    const fresh = loadCatalog();
    const result = await syncCatalog(fresh);
    currentCatalog = fresh;
    fileTailHandle.refresh(fresh);
    logger.info(
      { upserted: result.upserted, deactivated: result.deactivated, total: fresh.services.length },
      'catalog reloaded from file change',
    );
  });
  await runAutostart(currentCatalog);

  // ─── HTTP router ───────────────────────────────────────
  const app = new Hono();

  // reviews router (path 冁E�Eで /api/v1/reviews を持つ ので root mount)
  app.route('/', buildReviewsRouter());

  app.get('/api/v1/services', (c) => {
    const rows = db().all(drizzleSql`
      SELECT
        s.id, s.code, s.name, s.catalog_snapshot, s.updated_at,
        si.state, si.docker_id, si.last_seen_at,
        si.git_branch, si.git_hash, si.git_dirty, si.package_version, si.port,
        h.hostname AS host_hostname, h.name AS host_name
      FROM services s
      LEFT JOIN service_instances si ON si.service_id = s.id
      LEFT JOIN hosts h ON h.id = si.host_id
      WHERE s.is_active = 1
      ORDER BY s.code ASC
    `);
    return c.json({
      services: (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
        id: r.id,
        code: r.code,
        name: r.name,
        catalog_snapshot: typeof r.catalog_snapshot === 'string'
          ? JSON.parse(r.catalog_snapshot)
          : r.catalog_snapshot,
        state: r.state ?? 'unknown',
        docker_id: r.docker_id ?? null,
        last_seen_at: r.last_seen_at ?? null,
        git_branch: r.git_branch ?? null,
        git_hash: r.git_hash ?? null,
        git_dirty: r.git_dirty ?? null,
        package_version: r.package_version ?? null,
        port: r.port ?? null,
        host: r.host_hostname ? { hostname: r.host_hostname, name: r.host_name } : null,
        updated_at: r.updated_at,
      })),
    });
  });

  app.get('/api/v1/services/:code', (c) => {
    const code = c.req.param('code');
    const rows = db().all(drizzleSql`
      SELECT
        s.id, s.code, s.name, s.catalog_snapshot, s.updated_at,
        si.id AS instance_id, si.state, si.docker_id, si.last_seen_at,
        si.git_branch, si.git_hash, si.git_dirty, si.package_version, si.port,
        h.hostname AS host_hostname, h.name AS host_name
      FROM services s
      LEFT JOIN service_instances si ON si.service_id = s.id
      LEFT JOIN hosts h ON h.id = si.host_id
      WHERE s.code = ${code}
      LIMIT 1
    `) as Array<Record<string, unknown>>;
    if (rows.length === 0) return c.json({ error: 'not_found' }, 404);
    const r = rows[0]!;
    return c.json({
      id: r.id,
      code: r.code,
      name: r.name,
      catalog_snapshot: typeof r.catalog_snapshot === 'string'
        ? JSON.parse(r.catalog_snapshot)
        : r.catalog_snapshot,
      instance_id: r.instance_id ?? null,
      state: r.state ?? 'unknown',
      docker_id: r.docker_id ?? null,
      last_seen_at: r.last_seen_at ?? null,
      git_branch: r.git_branch ?? null,
      git_hash: r.git_hash ?? null,
      git_dirty: r.git_dirty ?? null,
      package_version: r.package_version ?? null,
      port: r.port ?? null,
      host: r.host_hostname ? { hostname: r.host_hostname, name: r.host_name } : null,
      updated_at: r.updated_at,
    });
  });

  app.get('/api/v1/services/:code/logs/recent', (c) => {
    const code = c.req.param('code');
    const limitRaw = Number(c.req.query('limit') ?? 200);
    const limit = Math.max(1, Math.min(2000, isFinite(limitRaw) ? limitRaw : 200));
    const rows = db().all(drizzleSql`
      SELECT sil.id, sil.ts, sil.level, sil.line
      FROM service_instance_logs sil
      JOIN service_instances si ON si.id = sil.service_instance_id
      JOIN services s ON s.id = si.service_id
      WHERE s.code = ${code}
      ORDER BY sil.ts DESC
      LIMIT ${limit}
    `);
    return c.json({ logs: rows });
  });

  app.get('/api/v1/error-tasks', (c) => {
    const state = c.req.query('state');
    const rows = state
      ? db().all(drizzleSql`
          SELECT et.*, s.code AS service_code, s.name AS service_name
          FROM error_tasks et
          LEFT JOIN service_instances si ON si.id = et.service_instance_id
          LEFT JOIN services s ON s.id = si.service_id
          WHERE et.state = ${state}
          ORDER BY et.last_seen_at DESC
          LIMIT 200
        `)
      : db().all(drizzleSql`
          SELECT et.*, s.code AS service_code, s.name AS service_name
          FROM error_tasks et
          LEFT JOIN service_instances si ON si.id = et.service_instance_id
          LEFT JOIN services s ON s.id = si.service_id
          ORDER BY et.last_seen_at DESC
          LIMIT 200
        `);
    return c.json({ tasks: rows });
  });

  app.patch('/api/v1/error-tasks/:id', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as {
      state?: 'open' | 'ack' | 'resolved' | 'dismissed' | 'snoozed';
      note?: string;
      snooze_until?: string;
    };
    const actor = c.req.header('x-concordia-actor') ?? c.req.header('x-excubitor-actor') ?? 'anonymous';
    const targetState = body.state ?? null;
    const snoozeMs = body.snooze_until ? new Date(body.snooze_until).getTime() : null;
    db().run(drizzleSql`
      UPDATE error_tasks
      SET state = COALESCE(${targetState}, state),
          note = COALESCE(${body.note ?? null}, note),
          snooze_until = COALESCE(${snoozeMs}, snooze_until),
          triaged_by = ${actor},
          triaged_at = ${Date.now()},
          updated_at = ${Date.now()}
      WHERE id = ${id}
    `);
    return c.json({ ok: true });
  });

  app.get('/api/v1/auto-fix/runs', (c) => {
    const taskId = c.req.query('error_task_id');
    const rows = taskId
      ? db().all(drizzleSql`
          SELECT * FROM auto_fix_runs
          WHERE error_task_id = ${taskId}
          ORDER BY created_at DESC
          LIMIT 50
        `)
      : db().all(drizzleSql`
          SELECT * FROM auto_fix_runs
          ORDER BY created_at DESC
          LIMIT 50
        `);
    return c.json({ runs: rows });
  });

  async function resolveTaskAndService(taskId: string): Promise<
    | { error: string; status: 400 | 404 }
    | { task: Record<string, unknown>; service: NonNullable<ReturnType<typeof findService>> }
  > {
    const taskRows = db().all(drizzleSql`
      SELECT et.id, et.summary, et.log_excerpt, s.code AS service_code, s.catalog_snapshot
      FROM error_tasks et
      LEFT JOIN service_instances si ON si.id = et.service_instance_id
      LEFT JOIN services s ON s.id = si.service_id
      WHERE et.id = ${taskId}
      LIMIT 1
    `) as Array<Record<string, unknown>>;
    if (taskRows.length === 0) return { error: 'not_found', status: 404 };
    const t = taskRows[0]!;
    const svcCode = t.service_code as string | null;
    if (!svcCode) return { error: 'no_service', status: 400 };
    const svc = findService(svcCode);
    if (!svc) return { error: 'service_not_in_catalog', status: 400 };
    if (!svc.auto_fix?.enabled) return { error: 'auto_fix_disabled', status: 400 };
    return { task: t, service: svc };
  }

  app.post('/api/v1/error-tasks/:id/auto-fix', async (c) => {
    const taskId = c.req.param('id');
    const resolved = await resolveTaskAndService(taskId);
    if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
    const { task: t, service: svc } = resolved;
    const actor = c.req.header('x-concordia-actor') ?? 'manual';
    try {
      const result = await runAutoFix({
        errorTaskId: taskId,
        service: svc,
        triggeredBy: actor,
        summary: t.summary as string,
        logExcerpt: (t.log_excerpt as string | null) ?? '',
      });
      return c.json({ ok: true, ...result });
    } catch (err) {
      return c.json({ error: 'auto_fix_failed', message: (err as Error).message }, 500);
    }
  });

  app.post('/api/v1/error-tasks/:id/investigate', async (c) => {
    const taskId = c.req.param('id');
    const resolved = await resolveTaskAndService(taskId);
    if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
    const { task: t, service: svc } = resolved;
    const actor = c.req.header('x-concordia-actor') ?? 'manual';
    try {
      const result = await runInvestigation({
        errorTaskId: taskId,
        service: svc,
        triggeredBy: actor,
        summary: t.summary as string,
        logExcerpt: (t.log_excerpt as string | null) ?? '',
      });
      return c.json({ ok: true, ...result });
    } catch (err) {
      return c.json({ error: 'investigate_failed', message: (err as Error).message }, 500);
    }
  });

  app.get('/api/v1/error-rules', (c) => {
    const rows = db().all(drizzleSql`SELECT * FROM error_rules ORDER BY name ASC`);
    return c.json({ rules: rows });
  });

  app.post('/api/v1/error-rules', async (c) => {
    const body = (await c.req.json()) as {
      name: string;
      pattern: string;
      pattern_type?: 'regex' | 'keyword';
      severity?: string;
      service_codes?: string[];
    };
    const id = randomUUID();
    const codes = body.service_codes ? JSON.stringify(body.service_codes) : null;
    db().run(drizzleSql`
      INSERT INTO error_rules (id, name, pattern, pattern_type, severity, service_codes)
      VALUES (${id}, ${body.name}, ${body.pattern}, ${body.pattern_type ?? 'regex'}, ${body.severity ?? 'error'}, ${codes})
    `);
    return c.json({ ok: true, id });
  });

  app.post('/api/v1/services/:code/control', async (c) => {
    const code = c.req.param('code');
    const svc = findService(code);
    if (!svc) return c.json({ error: 'not_found' }, 404);

    const body = await c.req.json().catch(() => ({}));
    const parsed = ControlBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_body', detail: parsed.error.flatten() }, 400);
    }
    const actor = c.req.header('x-concordia-actor') ?? 'anonymous';
    const result = await controlService(svc, parsed.data.action, actor);
    void syncDockerInstances(currentCatalog!).catch(() => {});
    return c.json({
      ok: result.ok,
      action: parsed.data.action,
      exit_code: result.exit_code,
      command: result.command,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  });

  return {
    router: app,
    shutdown: async () => {
      try { watcherHandle?.stop?.(); } catch { /* noop */ }
      try { scannerHandle?.stop?.(); } catch { /* noop */ }
      try { fileTailHandle.stop(); } catch { /* noop */ }
      const procs = listRunningProcesses();
      for (const p of procs) {
        try { p.child.kill('SIGTERM'); } catch { /* noop */ }
      }
    },
  };
}

