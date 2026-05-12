import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { sql as drizzleSql } from 'drizzle-orm';
import pino from 'pino';
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
import { subscribe as subscribeLogBus, type LogLine } from './log/bus.js';
import { attachProcessBridge } from './log/process-bridge.js';
import { startErrorDetector, setCatalogProvider } from './log/error-detector.js';
import * as infisical from './infisical/client.js';
import { seedDefaultRules } from './auto_fix/seed.js';
import { runAutoFix } from './auto_fix/runner.js';
import { buildReviewsRouter } from './reviews/router.js';

const logger = pino({ name: 'excubitor' });
const port = Number(process.env.EXCUBITOR_PORT ?? 17331);

// ─────────────── boot: catalog → DB sync ───────────────
// catalog はメモリ上で reload 可能にしておく (control API が svc を引くため)
let currentCatalog: Catalog;

async function boot() {
  currentCatalog = loadCatalog();
  const result = await syncCatalog(currentCatalog);
  logger.info(
    { upserted: result.upserted, deactivated: result.deactivated, total: currentCatalog.services.length },
    'catalog synced',
  );
  return currentCatalog;
}

function findService(code: string): Service | undefined {
  return currentCatalog?.services.find((s) => s.code === code);
}

const ControlBodySchema = z.object({
  action: z.enum(['start', 'stop', 'restart']),
});

// ─────────────── routes ───────────────
const app = new Hono();

app.get('/health', (c) =>
  c.json({
    ok: true,
    service: 'excubitor',
    version: '0.1.0',
  }),
);

app.route('/', buildReviewsRouter());

app.get('/api/v1/services', async (c) => {
  const rows = await db.execute(drizzleSql`
    SELECT
      s.id, s.code, s.name, s.catalog_snapshot, s.updated_at,
      si.state, si.docker_id, si.last_seen_at,
      si.git_branch, si.git_hash, si.git_dirty, si.package_version, si.port,
      h.hostname AS host_hostname, h.name AS host_name
    FROM services s
    LEFT JOIN service_instances si ON si.service_id = s.id
    LEFT JOIN hosts h ON h.id = si.host_id
    WHERE s.is_active = TRUE
    ORDER BY s.code ASC
  `);

  return c.json({
    services: (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      catalog: r.catalog_snapshot,
      state: r.state ?? 'unknown',
      docker_id: r.docker_id ?? null,
      last_seen_at: r.last_seen_at ?? null,
      git: {
        branch: r.git_branch ?? null,
        hash: r.git_hash ?? null,
        dirty: r.git_dirty ?? null,
      },
      package_version: r.package_version ?? null,
      port: r.port ?? null,
      host: r.host_hostname ? { hostname: r.host_hostname, name: r.host_name } : null,
      updated_at: r.updated_at,
    })),
  });
});

/**
 * 論理サービス (project_code) で集約した一覧。
 * 同じ project_code を持つ catalog entry を 1 group にまとめて、 components として返す。
 */
app.get('/api/v1/projects', async (c) => {
  const rows = await db.execute(drizzleSql`
    SELECT
      s.id, s.code, s.name, s.catalog_snapshot, s.updated_at,
      si.state, si.docker_id, si.last_seen_at,
      si.git_branch, si.git_hash, si.git_dirty, si.package_version, si.port,
      h.hostname AS host_hostname, h.name AS host_name
    FROM services s
    LEFT JOIN service_instances si ON si.service_id = s.id
    LEFT JOIN hosts h ON h.id = si.host_id
    WHERE s.is_active = TRUE
    ORDER BY s.code ASC
  `);

  type Row = Record<string, unknown>;
  const groups = new Map<string, { project_code: string; project_name: string; components: Row[] }>();
  for (const raw of (rows as unknown as Row[])) {
    const cat = raw.catalog_snapshot as Record<string, unknown>;
    const pc = (cat.project_code as string | undefined) ?? (raw.code as string);
    const pn = (cat.project_code as string | undefined) ? (cat.project_code as string) : (raw.name as string);
    const grp = groups.get(pc) ?? { project_code: pc, project_name: pn, components: [] };
    grp.components.push({
      code: raw.code,
      name: raw.name,
      component: (cat.component as string | undefined) ?? null,
      runtime: (cat.runtime as string | undefined) ?? null,
      state: raw.state ?? 'unknown',
      port: raw.port ?? (cat.port as number | undefined) ?? null,
      git: {
        branch: raw.git_branch ?? null,
        hash: raw.git_hash ?? null,
        dirty: raw.git_dirty ?? null,
      },
      package_version: raw.package_version ?? null,
      monitor_only: (cat.monitor_only as boolean | undefined) ?? false,
      host: raw.host_hostname ? { hostname: raw.host_hostname, name: raw.host_name } : null,
      last_seen_at: raw.last_seen_at ?? null,
      docker_id: raw.docker_id ?? null,
    });
    groups.set(pc, grp);
  }

  return c.json({ projects: Array.from(groups.values()) });
});

app.get('/api/v1/services/:code', async (c) => {
  const code = c.req.param('code');
  const rows = await db.execute(drizzleSql`
    SELECT
      s.id, s.code, s.name, s.catalog_snapshot, s.updated_at,
      si.state, si.docker_id, si.last_seen_at
    FROM services s
    LEFT JOIN service_instances si ON si.service_id = s.id AND si.host_id IS NULL
    WHERE s.code = ${code} AND s.is_active = TRUE
    LIMIT 1
  `);
  const arr = rows as unknown as Array<Record<string, unknown>>;
  if (arr.length === 0) return c.json({ error: 'not_found' }, 404);
  const r = arr[0]!;
  return c.json({
    id: r.id,
    code: r.code,
    name: r.name,
    catalog: r.catalog_snapshot,
    state: r.state ?? 'unknown',
    docker_id: r.docker_id ?? null,
    last_seen_at: r.last_seen_at ?? null,
    updated_at: r.updated_at,
  });
});

/**
 * SSE log stream — 指定サービスのリアルタイム log line を流す。
 * client から keep-alive を投げる必要なし。 server side で 25s ping。
 */
app.get('/api/v1/services/:code/logs', (c) => {
  const code = c.req.param('code');
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      const write = (event: string, data: unknown) => {
        controller.enqueue(enc.encode(`event: ${event}\n` + `data: ${JSON.stringify(data)}\n\n`));
      };
      write('hello', { code, ts: new Date().toISOString() });

      const unsub = subscribeLogBus((line: LogLine) => {
        if (line.service_code !== code) return;
        write('log', {
          channel: line.channel,
          ts: line.ts.toISOString(),
          line: line.line,
        });
      });

      const ping = setInterval(() => {
        controller.enqueue(enc.encode(`: ping\n\n`));
      }, 25_000);

      const close = () => {
        clearInterval(ping);
        unsub();
        try { controller.close(); } catch { /* noop */ }
      };
      c.req.raw.signal.addEventListener('abort', close);
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
});

/**
 * 最近の log を DB から (短期 process_logs テーブル) 取り出す。
 */
app.get('/api/v1/services/:code/logs/recent', async (c) => {
  const code = c.req.param('code');
  const limit = Number(c.req.query('limit') ?? 200);
  const rows = await db.execute(drizzleSql`
    SELECT pl.ts, pl.level, pl.line
    FROM process_logs pl
    JOIN service_instances si ON si.id = pl.service_instance_id
    JOIN services s ON s.id = si.service_id
    WHERE s.code = ${code}
    ORDER BY pl.ts DESC
    LIMIT ${limit}
  `);
  return c.json({ lines: rows });
});

// ─────────────── error tasks ───────────────
app.get('/api/v1/error-tasks', async (c) => {
  const state = c.req.query('state');
  const rows = await db.execute(drizzleSql`
    SELECT et.*, s.code AS service_code, s.name AS service_name
    FROM error_tasks et
    LEFT JOIN service_instances si ON si.id = et.service_instance_id
    LEFT JOIN services s ON s.id = si.service_id
    ${state ? drizzleSql`WHERE et.state = ${state}` : drizzleSql``}
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
  const actor = c.req.header('x-excubitor-actor') ?? 'anonymous';
  const targetState = body.state ?? null;
  await db.execute(drizzleSql`
    UPDATE error_tasks
    SET state = COALESCE(${targetState}, state),
        note = COALESCE(${body.note ?? null}, note),
        snooze_until = COALESCE(${body.snooze_until ?? null}::timestamptz, snooze_until),
        triaged_by = ${actor},
        triaged_at = now(),
        updated_at = now()
    WHERE id = ${id}::uuid
  `);
  return c.json({ ok: true });
});

// ─────────────── Infisical ───────────────
const BootstrapBodySchema = z.object({
  site_url: z.string().url(),
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
});

app.get('/api/v1/infisical/status', (c) => c.json(infisical.getStatus()));

app.post('/api/v1/infisical/bootstrap', async (c) => {
  const parsed = BootstrapBodySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', detail: parsed.error.flatten() }, 400);
  }
  try {
    await infisical.bootstrap(parsed.data);
  } catch (err) {
    return c.json({ error: 'bootstrap_failed', message: (err as Error).message }, 502);
  }
  const actor = c.req.header('x-excubitor-actor') ?? 'anonymous';
  await db.execute(drizzleSql`
    INSERT INTO audit_log (actor, action, target_type, target_id, payload)
    VALUES (${actor}, 'infisical.bootstrap', 'infisical', ${parsed.data.site_url}, ${JSON.stringify({ site_url: parsed.data.site_url })}::jsonb)
  `);
  return c.json({ ok: true, ...infisical.getStatus() });
});

app.post('/api/v1/infisical/forget', (c) => {
  infisical.forget();
  return c.json({ ok: true });
});

const SecretListQuerySchema = z.object({
  workspaceId: z.string(),
  environment: z.string(),
  secretPath: z.string().optional(),
});

app.get('/api/v1/infisical/secrets', async (c) => {
  if (!infisical.isBootstrapped()) {
    return c.json({ error: 'not_bootstrapped' }, 412);
  }
  const parsed = SecretListQuerySchema.safeParse({
    workspaceId: c.req.query('workspaceId'),
    environment: c.req.query('environment'),
    secretPath: c.req.query('secretPath') ?? undefined,
  });
  if (!parsed.success) return c.json({ error: 'invalid_query', detail: parsed.error.flatten() }, 400);
  try {
    const list = await infisical.listSecrets(parsed.data);
    return c.json(list);
  } catch (err) {
    return c.json({ error: 'infisical_call_failed', message: (err as Error).message }, 502);
  }
});

const SecretUpsertBodySchema = z.object({
  workspaceId: z.string(),
  environment: z.string(),
  secretName: z.string(),
  secretValue: z.string(),
  secretPath: z.string().optional(),
  comment: z.string().optional(),
});

app.put('/api/v1/infisical/secrets', async (c) => {
  if (!infisical.isBootstrapped()) return c.json({ error: 'not_bootstrapped' }, 412);
  const parsed = SecretUpsertBodySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid_body', detail: parsed.error.flatten() }, 400);
  try {
    await infisical.upsertSecret(parsed.data);
  } catch (err) {
    return c.json({ error: 'infisical_call_failed', message: (err as Error).message }, 502);
  }
  const actor = c.req.header('x-excubitor-actor') ?? 'anonymous';
  await db.execute(drizzleSql`
    INSERT INTO audit_log (actor, action, target_type, target_id, payload)
    VALUES (${actor}, 'infisical.secret.upsert', 'infisical-secret',
            ${parsed.data.workspaceId + '/' + parsed.data.environment + '/' + parsed.data.secretName},
            ${JSON.stringify({ name: parsed.data.secretName, env: parsed.data.environment })}::jsonb)
  `);
  return c.json({ ok: true });
});

const SecretDeleteQuerySchema = z.object({
  workspaceId: z.string(),
  environment: z.string(),
  secretName: z.string(),
  secretPath: z.string().optional(),
});

app.delete('/api/v1/infisical/secrets', async (c) => {
  if (!infisical.isBootstrapped()) return c.json({ error: 'not_bootstrapped' }, 412);
  const parsed = SecretDeleteQuerySchema.safeParse({
    workspaceId: c.req.query('workspaceId'),
    environment: c.req.query('environment'),
    secretName: c.req.query('secretName'),
    secretPath: c.req.query('secretPath') ?? undefined,
  });
  if (!parsed.success) return c.json({ error: 'invalid_query', detail: parsed.error.flatten() }, 400);
  try {
    await infisical.deleteSecret(parsed.data);
  } catch (err) {
    return c.json({ error: 'infisical_call_failed', message: (err as Error).message }, 502);
  }
  const actor = c.req.header('x-excubitor-actor') ?? 'anonymous';
  await db.execute(drizzleSql`
    INSERT INTO audit_log (actor, action, target_type, target_id, payload)
    VALUES (${actor}, 'infisical.secret.delete', 'infisical-secret',
            ${parsed.data.workspaceId + '/' + parsed.data.environment + '/' + parsed.data.secretName},
            ${JSON.stringify({ name: parsed.data.secretName, env: parsed.data.environment })}::jsonb)
  `);
  return c.json({ ok: true });
});

// ─────────────── auto-fix ───────────────

app.get('/api/v1/auto-fix/runs', async (c) => {
  const taskId = c.req.query('error_task_id');
  const rows = await db.execute(drizzleSql`
    SELECT * FROM auto_fix_runs
    ${taskId ? drizzleSql`WHERE error_task_id = ${taskId}::uuid` : drizzleSql``}
    ORDER BY created_at DESC
    LIMIT 50
  `);
  return c.json({ runs: rows });
});

app.post('/api/v1/error-tasks/:id/auto-fix', async (c) => {
  const taskId = c.req.param('id');
  // task + service を取得
  const taskRows = await db.execute(drizzleSql`
    SELECT et.id, et.summary, et.log_excerpt, s.code AS service_code, s.catalog_snapshot
    FROM error_tasks et
    LEFT JOIN service_instances si ON si.id = et.service_instance_id
    LEFT JOIN services s ON s.id = si.service_id
    WHERE et.id = ${taskId}::uuid
    LIMIT 1
  `);
  const arr = taskRows as unknown as Array<Record<string, unknown>>;
  if (arr.length === 0) return c.json({ error: 'not_found' }, 404);
  const t = arr[0]!;
  const svcCode = t.service_code as string | null;
  if (!svcCode) return c.json({ error: 'no_service' }, 400);
  const svc = findService(svcCode);
  if (!svc) return c.json({ error: 'service_not_in_catalog' }, 400);
  if (!svc.auto_fix?.enabled) return c.json({ error: 'auto_fix_disabled' }, 400);

  const actor = c.req.header('x-excubitor-actor') ?? 'manual';
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

// ─────────────── error rules ───────────────
app.get('/api/v1/error-rules', async (c) => {
  const rows = await db.execute(drizzleSql`SELECT * FROM error_rules ORDER BY name ASC`);
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
  await db.execute(drizzleSql`
    INSERT INTO error_rules (name, pattern, pattern_type, severity, service_codes)
    VALUES (
      ${body.name},
      ${body.pattern},
      ${body.pattern_type ?? 'regex'},
      ${body.severity ?? 'error'},
      ${body.service_codes ?? null}
    )
  `);
  return c.json({ ok: true });
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

  // v0.1: actor は header X-Excubitor-Actor or "anonymous"
  const actor = c.req.header('x-excubitor-actor') ?? 'anonymous';
  const result = await controlService(svc, parsed.data.action, actor);

  // 直後に scanner を 1 回回して state を即時反映
  void syncDockerInstances(currentCatalog).catch(() => {});

  return c.json({
    ok: result.ok,
    action: parsed.data.action,
    exit_code: result.exit_code,
    command: result.command,
    stdout: result.stdout,
    stderr: result.stderr,
  });
});

// ─────────────── start ───────────────
boot()
  .then(async (catalog) => {
    await seedDefaultRules();
    attachProcessBridge();
    setCatalogProvider(() => currentCatalog);
    await startErrorDetector();
    startScannerLoop(catalog);
    watchCatalog('catalog/services.yaml', async () => {
      const fresh = loadCatalog();
      const result = await syncCatalog(fresh);
      currentCatalog = fresh;
      logger.info(
        { upserted: result.upserted, deactivated: result.deactivated, total: fresh.services.length },
        'catalog reloaded from file change',
      );
    });

    await runAutostart(catalog);

    serve({ fetch: app.fetch, port }, (info) => {
      logger.info(
        { port: info.port },
        `Excubitor server listening on http://localhost:${info.port}`,
      );
    });
  })
  .catch((err) => {
    logger.error({ err }, 'boot failed');
    process.exit(1);
  });

// 終了時に spawn した子プロセスをきれいに止める
function shutdown(signal: string) {
  const procs = listRunningProcesses();
  logger.info({ signal, count: procs.length }, 'shutting down spawned processes');
  for (const p of procs) {
    try { p.child.kill('SIGTERM'); } catch { /* noop */ }
  }
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
