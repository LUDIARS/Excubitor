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
import { attachProcessBridge } from './log/process-bridge.js';
import { startFileTail, type FileTailHandle } from './log/file-tail.js';
import { startErrorDetector, setCatalogProvider } from './log/error-detector.js';
import { seedDefaultRules } from './auto_fix/seed.js';
import { runAutoFix } from './auto_fix/runner.js';
import { runInvestigation } from './auto_fix/investigate.js';
import { buildReviewsRouter } from './reviews/router.js';
import { buildHubRouter } from './hub/router.js';
import { buildLaunchRouter } from './launch/router.js';
import { getLaunchProfile } from './launch/profile.js';
import { startSelection } from './launch/orchestrator.js';
import { buildConfigRouter } from './secrets/router.js';
import { buildSecretAgentRouter } from './secrets/agent-router.js';
import { getOrCreateAgentToken, agentTokenPath } from './secrets/agent-token.js';
import { applyInfisicalToEnv } from './secrets/config-store.js';
import { reconcileProcesses } from './process/reconcile.js';
import { detectSafeMode, setSafeMode, isSafeMode } from './safe-mode.js';
import { setTopologyFromCatalog, getTopologyEnv } from './process/topology.js';
import { setGlobalEnv } from './process/inject.js';
import { buildUpdateRouter } from './update/router.js';
import { buildDiscoveryRouter } from './discovery/router.js';
import { buildLogStreamRouter } from './log/sse.js';
import { buildPortsRouter } from './scanner/ports-router.js';
import { buildReleaseRouter } from './release/router.js';
import { startMemoryLoop } from './memory/loop.js';
import { buildMemoryRouter } from './memory/router.js';
import { buildFederationRouter } from './federation/router.js';
import { arsRoot } from './shared/roots.js';
import { reconcileMcpJson } from './mcp/mcp-json.js';

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
  // 設定ファイルに Infisical identity があれば process.env に注入 (relay の前提)。
  // 無ければ未設定のまま → UI が入力を促す。
  if (applyInfisicalToEnv()) {
    logger.info('Infisical identity loaded from config file');
  } else {
    logger.warn('Infisical identity not configured — secret relay は UI 設定待ち');
  }

  // secret-agent: 常駐 resolve エンドポイント用のローカルトークンを用意 (無ければ生成)。
  // 各サービスは同じトークン (env or token ファイル) で /api/v1/secrets/resolve を叩く。
  getOrCreateAgentToken();
  logger.info({ tokenPath: agentTokenPath() }, 'secret-agent token ready');

  // .mcp.json (ワークスペース直下) の excubitor エントリを arsRoot 由来パスに整合する。
  // 自分の MCP サーバ (Excubitor/src/mcp/server.ts) を指すので Excubitor が own。
  // E:/Document/Ars 固定だと別ドライブのマシンで MCP が起動できないのを解消。
  try {
    const r = reconcileMcpJson(arsRoot());
    if (r.changed) logger.info({ path: r.path, reason: r.reason }, '.mcp.json reconciled');
  } catch (err) {
    logger.warn({ err: (err as Error).message }, '.mcp.json reconcile failed (継続)');
  }

  // boot: catalog ↁEDB sync
  currentCatalog = loadCatalog();
  const sync = await syncCatalog(currentCatalog);
  logger.info(
    { upserted: sync.upserted, deactivated: sync.deactivated, total: currentCatalog.services.length },
    'catalog synced',
  );

  // catalog から topology env (URL/port) を構築。 spawn 時に全サービスへ注入する。
  setTopologyFromCatalog(currentCatalog);
  setGlobalEnv(currentCatalog.global?.env ?? {});

  // 永続化された running/pending な node プロセスを実体と突合 (生存→再採用 / 死亡→crashed)。
  // detached 起動なので Excubitor 再起動を跨いでサービスは生きており、 ここで管理下に戻す。
  reconcileProcesses(currentCatalog);

  await seedDefaultRules();
  attachProcessBridge();
  const fileTailHandle: FileTailHandle = startFileTail(currentCatalog);
  setCatalogProvider(() => currentCatalog!);
  await startErrorDetector();
  const scannerHandle = startScannerLoop(currentCatalog);
  // メモリ監視ループ (プロセス RSS / docker stats / WSL → 時系列 + leak 検知)。
  // catalog は live 参照で渡し、 file watch 後の memory_monitor 設定変更にも追従させる。
  const memoryHandle = startMemoryLoop(() => currentCatalog!);
  // catalog をファイルから再読込し DB / topology / file-tail に反映する (watcher + scan 共用)。
  const reloadCatalog = async (reason: string): Promise<number> => {
    const fresh = loadCatalog();
    const result = await syncCatalog(fresh);
    currentCatalog = fresh;
    setTopologyFromCatalog(fresh);
    setGlobalEnv(fresh.global?.env ?? {});
    fileTailHandle.refresh(fresh);
    logger.info(
      { upserted: result.upserted, deactivated: result.deactivated, total: fresh.services.length, reason },
      'catalog reloaded',
    );
    return fresh.services.length;
  };
  const watcherHandle = watchCatalog('catalog/services.yaml', async () => {
    await reloadCatalog('file change');
  });
  // SafeMode: 何も起動せず Excubitor 本体だけ立ち上げる (autostart / auto-launch を抑止)。
  // 監視・スキャン・Web GUI・制御 API は通常どおり動くので、 起動後に手動で立ち上げられる。
  const safeMode = detectSafeMode();
  setSafeMode(safeMode);
  if (safeMode) {
    logger.warn(
      'SAFE MODE: autostart と保存済み起動セットの auto-launch をスキップ (Excubitor のみ起動)',
    );
  } else {
    await runAutostart(currentCatalog);

    // 初回ウィザード完了済み + auto_launch なら、 保存済み起動セットを boot で一括起動する
    // (「次回自動」)。 未設定 (初回) なら何も起動せず、 UI のウィザードを待つ。
    const profile = getLaunchProfile();
    if (profile.configured && profile.autoLaunch && profile.selection.length > 0) {
      logger.info({ selection: profile.selection }, 'auto-launching saved launch set');
      void startSelection(currentCatalog, profile.selection).catch((err: unknown) =>
        logger.error({ err: (err as Error).message }, 'auto-launch failed'),
      );
    }
  }

  // ─── HTTP router ───────────────────────────────────────
  const app = new Hono();

  // reviews router (path 冁E�Eで /api/v1/reviews を持つ ので root mount)
  app.route('/', buildReviewsRouter());

  // Corpus multi-hub backend (/api/hub/*)
  app.route('/', buildHubRouter());

  // ランチャー API (/api/v1/launch/* + /api/v1/projects)
  app.route('/', buildLaunchRouter(() => currentCatalog!));

  // 設定 API (/api/v1/config/* — Infisical identity + サービスマッピング)
  app.route('/', buildConfigRouter({ onDomainRootChanged: () => reloadCatalog('domain root change') }));

  // secret-agent (/api/v1/secrets/resolve — service code → resolved secret、 token 認証)
  app.route('/', buildSecretAgentRouter((code) => findService(code)?.infisical));

  // アップデート確認・配信 (/api/v1/updates, /api/v1/services/:code/update)
  app.route('/', buildUpdateRouter(() => currentCatalog!));

  // 新規サービス検出 + スキャン自動カタログ (/api/v1/discovery[, /scan])
  app.route('/', buildDiscoveryRouter(() => currentCatalog!, () => reloadCatalog('scan')));

  // リリースビルド (/api/v1/releases — 自己完結ランナブル配布物の組み立て)
  app.route('/', buildReleaseRouter(() => currentCatalog));

  // ライブログ SSE (/api/v1/services/:code/logs, /api/v1/logs[/recent])
  app.route('/', buildLogStreamRouter());

  // ポート衝突検知 (/api/v1/ports)
  app.route('/', buildPortsRouter(() => currentCatalog!));

  // メモリ監視 (/api/v1/memory/summary, /api/v1/memory/series)
  app.route('/', buildMemoryRouter(() => currentCatalog!));

  // 他拠点連携 (/api/v1/peers/*, /api/v1/federation/* — 認証付きピア集約/操作)
  app.route('/', buildFederationRouter(() => currentCatalog!));

  // 運用メタ (frontend が SafeMode バッジ等を出すため)。
  app.get('/api/v1/system', (c) =>
    c.json({ service: 'excubitor', safe_mode: isSafeMode() }),
  );

  // topology env (Excubitor が catalog から導出して全サービスに注入する URL/port)。
  app.get('/api/v1/topology', (c) => c.json({ env: getTopologyEnv() }));

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

  // 稼働率の時系列 (liveness_history の ok 1/0)。 起動中サービスのメトリクスグラフ用。
  app.get('/api/v1/services/:code/liveness', (c) => {
    const code = c.req.param('code');
    const windowMin = Math.max(1, Math.min(1440, Number(c.req.query('window_min') ?? 120)));
    const since = Date.now() - windowMin * 60_000;
    const rows = db().all(drizzleSql`
      SELECT lh.probed_at AS t, lh.ok AS ok
      FROM liveness_history lh
      JOIN service_instances si ON si.id = lh.service_instance_id
      JOIN services s ON s.id = si.service_id
      WHERE s.code = ${code} AND lh.probed_at >= ${since}
      ORDER BY lh.probed_at ASC
      LIMIT 2000
    `) as Array<{ t: number; ok: number }>;
    const series = rows.map((r) => ({ t: Number(r.t), ok: Number(r.ok) }));
    const ratio = series.length > 0 ? series.reduce((a, s) => a + s.ok, 0) / series.length : null;
    return c.json({ code, window_min: windowMin, uptime_ratio: ratio, series });
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
    if (svc.disabled) return c.json({ error: 'service_disabled' }, 400);

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
      // 監視・スキャン系のみ停止する。 spawn したサービスは detached なので
      // ここでは kill しない (= Excubitor 再起動でサービスを道連れにしない)。
      // 明示停止は stop API / launcher stop からのみ行う。
      try { watcherHandle?.stop?.(); } catch { /* noop */ }
      try { scannerHandle?.stop?.(); } catch { /* noop */ }
      try { memoryHandle?.stop?.(); } catch { /* noop */ }
      try { fileTailHandle.stop(); } catch { /* noop */ }
    },
  };
}

