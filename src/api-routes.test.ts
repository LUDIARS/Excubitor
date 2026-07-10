import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import { openDb, closeDb } from './db/index.js';
import { db, resetDbClientForTests } from './db/client.js';

type AnyCatalog = {
  project_versions: Record<string, { major: number; minor: number }>;
  services: Array<Record<string, unknown>>;
  global?: { env?: Record<string, string> };
  memory_monitor: {
    enabled: boolean;
    interval_sec: number;
    retention_hours: number;
    default_service_rss_budget_mb: number;
    default_service_cpu_budget_pct: number;
    wsl: {
      enabled: boolean;
      distros: string[];
      leak_window_min: number;
      leak_threshold_mb_per_hr: number;
    };
    cpu_alert: {
      enabled: boolean;
      threshold_pct: number;
      window_min: number;
      sustained_ratio: number;
      min_samples: number;
    };
  };
  retention: {
    enabled: boolean;
    logs_hours: number;
    liveness_hours: number;
    parquet_days: number;
    interval_min: number;
    batch_rows: number;
  };
  log_store: {
    ring_lines_per_service: number;
    ring_lines_global: number;
    compact_hour_utc: number;
  };
};

const mocks = vi.hoisted(() => ({
  reviewRoot: 'E:\\tmp\\excubitor-api-review-root',
  logsRoot: 'E:\\tmp\\excubitor-api-logs',
  catalog: null as AnyCatalog | null,
  serviceMap: {} as Record<string, Record<string, unknown>>,
  domainRoot: '.example.test',
  identity: null as null | { siteUrl: string; environment: string; clientId: string; clientSecret: string },
  syncCatalog: vi.fn(async () => ({ upserted: 0, deactivated: 0 })),
  watchCatalog: vi.fn(() => ({ stop: vi.fn() })),
  startScannerLoop: vi.fn(() => ({ stop: vi.fn() })),
  syncDockerInstances: vi.fn(async () => undefined),
  syncHealthyServiceStates: vi.fn(async () => undefined),
  controlService: vi.fn(async () => ({
    ok: true,
    exit_code: 0,
    command: 'mock-control',
    stdout: 'started',
    stderr: '',
  })),
  runAutostart: vi.fn(async () => undefined),
  attachProcessBridge: vi.fn(),
  startFileTail: vi.fn(() => ({ refresh: vi.fn(), stop: vi.fn() })),
  startErrorDetector: vi.fn(async () => undefined),
  setCatalogProvider: vi.fn(),
  seedDefaultRules: vi.fn(async () => undefined),
  runAutoFix: vi.fn(async () => ({ state: 'queued', branch: 'auto/fix' })),
  runInvestigation: vi.fn(async () => ({ state: 'queued', branch: 'auto/investigate' })),
  getLaunchProfile: vi.fn(() => ({
    configured: true,
    autoLaunch: false,
    selection: ['svc-a'],
    updatedAt: 123,
  })),
  saveLaunchProfile: vi.fn((input: { selection: string[]; autoLaunch?: boolean; configured?: boolean }) => ({
    configured: input.configured ?? true,
    autoLaunch: input.autoLaunch ?? false,
    selection: input.selection,
    updatedAt: 456,
  })),
  runPreflight: vi.fn(async (_services: unknown, codes: string[]) => ({ ok: true, codes })),
  startSelection: vi.fn(async (_catalog: unknown, codes: string[]) => ({ ok: true, started: codes })),
  stopSelection: vi.fn(async (_catalog: unknown, codes: string[]) => codes.map((code) => ({ code, ok: true }))),
  setTopologyFromCatalog: vi.fn(),
  getTopologyEnv: vi.fn(() => ({ SVC_A_URL: 'http://localhost:1234' })),
  setGlobalEnv: vi.fn(),
  resolveInjectEnv: vi.fn(async () => ({ REQUIRED_ONE: 'set', EXTRA: 'value' })),
  reconcileProcesses: vi.fn(),
  detectSafeMode: vi.fn(() => false),
  detectServiceMode: vi.fn(() => false),
  setSafeMode: vi.fn(),
  isSafeMode: vi.fn(() => false),
  getOrCreateAgentToken: vi.fn(() => 'good'),
  agentTokenPath: vi.fn(() => 'E:\\tmp\\excubitor-agent-token'),
  verifyAgentToken: vi.fn((header?: string | null) => header === 'Bearer good' || header === 'good'),
  verifyIdentity: vi.fn(async () => undefined),
  resolveServiceSecrets: vi.fn(async () => ({
    ok: true,
    secrets: { REQUIRED_ONE: 'set' },
    projectId: 'proj-secret',
    environment: 'dev',
  })),
  reconcileMcpJson: vi.fn(() => ({ changed: false, path: 'E:\\tmp\\.mcp.json', reason: 'ok' })),
  resolveBuildVersion: vi.fn(async () => ({
    project_code: 'excubitor',
    major: 0,
    minor: 1,
    patch: 42,
    version: '0.1.42',
    patch_source: 'fallback',
    git_hash: 'abc123',
  })),
  runEmergencyAction: vi.fn(async (_catalog: unknown, _svc: unknown, action: string, _prompt?: string, port?: number) => ({
    ok: true,
    action,
    port: port ?? null,
    pids: port ? [1111] : [],
    stdout: 'fixed',
    stderr: '',
  })),
  checkAllUpdates: vi.fn(async () => [{ code: 'svc-a', available: false }]),
  checkUpdate: vi.fn(async (svc: { code: string }) => ({ code: svc.code, available: false })),
  recentCommits: vi.fn(async () => [{ hash: 'abc', subject: 'commit', author: 'dev', date: '2026-01-01', relative: 'today' }]),
  branchStatus: vi.fn(async (svc: { code: string }) => ({ code: svc.code, current: 'main', branches: [] })),
  applyUpdate: vi.fn(async (svc: { code: string }) => ({ ok: true, code: svc.code, steps: [] })),
  discoverServices: vi.fn(async () => ({ candidates: [], missing: [] })),
  runScan: vi.fn(async () => ({ written: 1, candidates: [] })),
  buildPortReport: vi.fn(async () => ({ listeners: [], declared: [], conflicts: [] })),
  listReleaseManifests: vi.fn(() => [{ name: 'demo', path: 'demo.yaml' }]),
  loadReleaseManifest: vi.fn(() => ({
    name: 'demo',
    display_name: 'Demo',
    description: 'Demo release',
    primary: 'svc-a',
    components: [{ code: 'svc-a', role: 'primary' }],
  })),
  planRelease: vi.fn(() => ({
    errors: [],
    components: [{
      component: { code: 'svc-a', role: 'primary' },
      repoDir: 'E:\\tmp\\svc-a',
      bundleSubdir: 'app',
    }],
  })),
  readGitMeta: vi.fn(async () => ({ branch: 'main', hash: 'abc', dirty: false })),
  buildRelease: vi.fn(async () => ({ ok: true, archive: 'demo.zip' })),
  fetchNode: vi.fn(async () => ({
    ok: true,
    status: 200,
    error: null,
    data: {
      node: 'remote-a',
      summary: { service: 'excubitor', services_total: 1, up: 1, down: 0, unknown: 0, open_errors: 0 },
      services: [{ code: 'remote-svc', name: 'Remote', state: 'running', port: 9999, git_branch: 'main' }],
      host: null,
    },
  })),
  remoteControl: vi.fn(async () => ({ ok: true, status: 200, error: null, data: { ok: true } })),
  remoteUpdate: vi.fn(async () => ({ ok: true, status: 200, error: null, data: { ok: true } })),
  updateServiceCatalogInfo: vi.fn(() => ({ updated: true })),
  startMemoryLoop: vi.fn(() => ({ stop: vi.fn() })),
}));

vi.mock('./shared/logger.js', () => ({
  createNamedLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('./shared/diagnostic-log.js', () => ({ writeDiagnostic: vi.fn() }));
vi.mock('./shared/roots.js', () => ({
  arsRoot: () => mocks.reviewRoot,
  domainRoot: () => mocks.domainRoot,
}));
vi.mock('./shared/build-version.js', () => ({ resolveBuildVersion: mocks.resolveBuildVersion }));

vi.mock('./catalog/loader.js', () => ({
  TIER_ORDER: ['saas', 'infra', 'personal', 'local-app'],
  loadCatalog: () => mocks.catalog,
  serviceTier: (svc: { tier?: string; runtime?: string }) => svc.tier ?? (svc.runtime === 'app' ? 'local-app' : 'saas'),
}));
vi.mock('./catalog/sync.js', () => ({ syncCatalog: mocks.syncCatalog }));
vi.mock('./catalog/watcher.js', () => ({ watchCatalog: mocks.watchCatalog }));
vi.mock('./catalog/editor.js', () => ({ updateServiceCatalogInfo: mocks.updateServiceCatalogInfo }));
vi.mock('./catalog/auto-catalog.js', () => ({ runScan: mocks.runScan }));

vi.mock('./scanner/loop.js', () => ({ startScannerLoop: mocks.startScannerLoop }));
vi.mock('./scanner/sync.js', () => ({ syncDockerInstances: mocks.syncDockerInstances }));
vi.mock('./scanner/health-state.js', () => ({ syncHealthyServiceStates: mocks.syncHealthyServiceStates }));
vi.mock('./scanner/ports.js', () => ({ buildPortReport: mocks.buildPortReport }));

vi.mock('./control/manager.js', () => ({ controlService: mocks.controlService }));
vi.mock('./process/autostart.js', () => ({ runAutostart: mocks.runAutostart }));
vi.mock('./process/reconcile.js', () => ({ reconcileProcesses: mocks.reconcileProcesses }));
vi.mock('./process/topology.js', () => ({
  setTopologyFromCatalog: mocks.setTopologyFromCatalog,
  getTopologyEnv: mocks.getTopologyEnv,
}));
vi.mock('./process/inject.js', () => ({
  setGlobalEnv: mocks.setGlobalEnv,
  resolveInjectEnv: mocks.resolveInjectEnv,
}));

vi.mock('./log/process-bridge.js', () => ({ attachProcessBridge: mocks.attachProcessBridge }));
vi.mock('./log/file-tail.js', () => ({ startFileTail: mocks.startFileTail }));
vi.mock('./log/error-detector.js', () => ({
  startErrorDetector: mocks.startErrorDetector,
  setCatalogProvider: mocks.setCatalogProvider,
}));
vi.mock('./log/logs-root.js', () => ({ sharedLogsRoot: () => mocks.logsRoot }));

vi.mock('./auto_fix/seed.js', () => ({ seedDefaultRules: mocks.seedDefaultRules }));
vi.mock('./auto_fix/runner.js', () => ({ runAutoFix: mocks.runAutoFix }));
vi.mock('./auto_fix/investigate.js', () => ({ runInvestigation: mocks.runInvestigation }));

vi.mock('./launch/profile.js', () => ({
  getLaunchProfile: mocks.getLaunchProfile,
  saveLaunchProfile: mocks.saveLaunchProfile,
}));
vi.mock('./launch/preflight.js', () => ({ runPreflight: mocks.runPreflight }));
vi.mock('./launch/orchestrator.js', () => ({
  startSelection: mocks.startSelection,
  stopSelection: mocks.stopSelection,
}));

vi.mock('./secrets/config-store.js', () => ({
  applyInfisicalToEnv: vi.fn(() => false),
  getServiceMap: () => mocks.serviceMap,
  setServiceMap: (next: Record<string, Record<string, unknown>>) => { mocks.serviceMap = next; },
  resolveServiceInfisical: (code: string, fallback?: Record<string, unknown>) => mocks.serviceMap[code] ?? fallback,
  saveInfisicalIdentity: (input: { siteUrl: string; environment?: string; clientId: string; clientSecret: string }) => {
    mocks.identity = {
      siteUrl: input.siteUrl.replace(/\/$/, ''),
      environment: input.environment ?? 'dev',
      clientId: input.clientId,
      clientSecret: input.clientSecret,
    };
  },
  getInfisicalIdentity: () => mocks.identity,
  getIdentityStatus: () => ({
    configured: mocks.identity !== null,
    siteUrl: mocks.identity?.siteUrl ?? null,
    environment: mocks.identity?.environment ?? null,
    clientIdHint: mocks.identity ? `...${mocks.identity.clientId.slice(-4)}` : null,
    storePath: 'E:\\tmp\\config.enc',
  }),
  getDomainRootStatus: () => ({
    value: mocks.domainRoot,
    source: 'config',
    configured: true,
    env: null,
    default_value: '',
    storePath: 'E:\\tmp\\config.enc',
  }),
  setDomainRootOverride: (input: string) => {
    mocks.domainRoot = input.startsWith('.') ? input : `.${input}`;
    return mocks.domainRoot;
  },
}));
vi.mock('./secrets/infisical.js', () => ({ verifyIdentity: mocks.verifyIdentity }));
vi.mock('./secrets/agent-token.js', () => ({
  getOrCreateAgentToken: mocks.getOrCreateAgentToken,
  agentTokenPath: mocks.agentTokenPath,
  verifyAgentToken: mocks.verifyAgentToken,
}));
vi.mock('./secrets/resolve.js', () => ({ resolveServiceSecrets: mocks.resolveServiceSecrets }));

vi.mock('./safe-mode.js', () => ({
  detectSafeMode: mocks.detectSafeMode,
  detectServiceMode: mocks.detectServiceMode,
  setSafeMode: mocks.setSafeMode,
  isSafeMode: mocks.isSafeMode,
}));

vi.mock('./mcp/mcp-json.js', () => ({ reconcileMcpJson: mocks.reconcileMcpJson }));
vi.mock('./ops/emergency.js', () => ({ runEmergencyAction: mocks.runEmergencyAction }));

vi.mock('./update/checker.js', () => ({
  checkAllUpdates: mocks.checkAllUpdates,
  checkUpdate: mocks.checkUpdate,
  recentCommits: mocks.recentCommits,
  branchStatus: mocks.branchStatus,
}));
vi.mock('./update/apply.js', () => ({ applyUpdate: mocks.applyUpdate }));

vi.mock('./discovery/scan.js', () => ({ discoverServices: mocks.discoverServices }));

vi.mock('./release/manifest.js', () => ({
  listReleaseManifests: mocks.listReleaseManifests,
  loadReleaseManifest: mocks.loadReleaseManifest,
}));
vi.mock('./release/plan.js', () => ({ planRelease: mocks.planRelease }));
vi.mock('./release/git-meta.js', () => ({ readGitMeta: mocks.readGitMeta }));
vi.mock('./release/orchestrator.js', () => ({ buildRelease: mocks.buildRelease }));

vi.mock('./federation/secret-box.js', () => ({
  sealSecret: (plaintext: string) => plaintext,
  openSecret: (stored: string | null) => stored,
}));
vi.mock('./federation/client.js', () => ({
  fetchNode: mocks.fetchNode,
  remoteControl: mocks.remoteControl,
  remoteUpdate: mocks.remoteUpdate,
}));

vi.mock('./memory/loop.js', () => ({ startMemoryLoop: mocks.startMemoryLoop }));

function makeCatalog(): AnyCatalog {
  return {
    project_versions: { excubitor: { major: 0, minor: 1 } },
    global: { env: { GLOBAL_FLAG: '1' } },
    memory_monitor: {
      enabled: true,
      interval_sec: 60,
      retention_hours: 48,
      default_service_rss_budget_mb: 1024,
      default_service_cpu_budget_pct: 80,
      wsl: { enabled: true, distros: [], leak_window_min: 120, leak_threshold_mb_per_hr: 200 },
      cpu_alert: { enabled: true, threshold_pct: 85, window_min: 15, sustained_ratio: 0.8, min_samples: 8 },
    },
    retention: { enabled: true, logs_hours: 72, liveness_hours: 168, parquet_days: 90, interval_min: 60, batch_rows: 50_000 },
    log_store: { ring_lines_per_service: 2_000, ring_lines_global: 20_000, compact_hour_utc: 18 },
    services: [
      {
        code: 'svc-a',
        name: 'Service A',
        runtime: 'node',
        tier: 'saas',
        project_code: 'proj-a',
        cwd: 'E:\\tmp\\svc-a',
        command: 'npm start',
        port: 1234,
        required_env: ['REQUIRED_ONE'],
        infisical: {
          project_id: 'proj-secret',
          environment: 'dev',
          inject: true,
          prefix: '',
          required_env: ['REQUIRED_ONE'],
        },
        auto_fix: {
          enabled: true,
          agent: 'claude-code',
          max_auto_attempts: 1,
          branch_prefix: 'auto/',
          create_pr: false,
          pr_draft: true,
        },
        memory: { enabled: true, rss_budget_mb: 512, cpu_budget_pct: 70 },
      },
      {
        code: 'app-a',
        name: 'App A',
        runtime: 'app',
        tier: 'local-app',
        app_kind: 'native',
        exec: 'E:\\tmp\\app-a.exe',
      },
      {
        code: 'disabled',
        name: 'Disabled',
        runtime: 'node',
        disabled: true,
        command: 'npm start',
      },
    ],
  };
}

function resetFiles(): void {
  rmSync(mocks.reviewRoot, { recursive: true, force: true });
  rmSync(mocks.logsRoot, { recursive: true, force: true });
  mkdirSync(join(mocks.reviewRoot, 'RepoA', 'review', '2026-01-01'), { recursive: true });
  writeFileSync(
    join(mocks.reviewRoot, 'RepoA', 'review', 'latest.json'),
    JSON.stringify({ date: '2026-01-01', weighted_score: 'A', critical_count: 1, high_count: 2 }),
    'utf8',
  );
  writeFileSync(join(mocks.reviewRoot, 'RepoA', 'review', '2026-01-01', 'REVIEW.md'), '# Review\n', 'utf8');

  mkdirSync(join(mocks.logsRoot, 'svc-a'), { recursive: true });
  writeFileSync(
    join(mocks.logsRoot, 'svc-a', '2026-01-01.jsonl'),
    JSON.stringify({ ts: 1000, level: 'info', service: 'svc-a', channel: 'llm', msg: 'llm call' }) + '\n',
    'utf8',
  );
}

function seedDb(): void {
  const now = Date.now();
  const svcA = mocks.catalog!.services[0]!;
  const appA = mocks.catalog!.services[1]!;
  db().run(sql`
    INSERT INTO services (id, code, name, catalog_snapshot)
    VALUES
      ('svc-a-id', 'svc-a', 'Service A', ${JSON.stringify(svcA)}),
      ('app-a-id', 'app-a', 'App A', ${JSON.stringify(appA)})
  `);
  db().run(sql`
    INSERT INTO service_instances
      (id, service_id, state, pid, last_seen_at, git_branch, git_hash, git_dirty, package_version, port)
    VALUES
      ('inst-a', 'svc-a-id', 'running', 4242, ${now}, 'main', 'abcdef', 0, '1.2.3', 1234),
      ('inst-app', 'app-a-id', 'stopped', NULL, ${now - 1000}, NULL, NULL, NULL, NULL, NULL)
  `);
  db().run(sql`
    INSERT INTO liveness_history (service_instance_id, probed_at, ok, latency_ms)
    VALUES ('inst-a', ${now}, 1, 12)
  `);
  db().run(sql`
    INSERT INTO error_rules (id, name, pattern, pattern_type, severity)
    VALUES ('rule-1', 'boom', 'boom', 'keyword', 'error')
  `);
  db().run(sql`
    INSERT INTO error_tasks
      (id, rule_id, service_instance_id, severity, summary, log_excerpt, first_seen_at, last_seen_at, state)
    VALUES
      ('task-1', 'rule-1', 'inst-a', 'error', 'boom happened', 'boom', ${now - 1000}, ${now}, 'open')
  `);
  db().run(sql`
    INSERT INTO auto_fix_runs (id, error_task_id, service_code, state, action_type)
    VALUES ('run-1', 'task-1', 'svc-a', 'finished', 'fix')
  `);
  db().run(sql`
    INSERT INTO memory_samples
      (target_kind, target_key, service_instance_id, source, sampled_at, rss_bytes, heap_used_bytes, heap_total_bytes, cpu_pct, pid, detail)
    VALUES
      ('service', 'svc-a', 'inst-a', 'process', ${now - 1000}, ${256 * 1024 * 1024}, NULL, NULL, 12.5, 4242, '{"procCount":1}'),
      ('service', 'svc-a', 'inst-a', 'metrics', ${now}, ${250 * 1024 * 1024}, ${80 * 1024 * 1024}, ${120 * 1024 * 1024}, NULL, NULL, '{}'),
      ('host', 'host', NULL, 'host', ${now}, ${8 * 1024 * 1024 * 1024}, NULL, NULL, 20, NULL, '{"total_mem_bytes":16000000000}')
  `);
}

async function bootRouter(): Promise<Hono> {
  const mod = await import('./index.js');
  const booted = await mod.bootObservability();
  return booted.router;
}

function jsonHeaders(headers?: Record<string, string>): Record<string, string> {
  return { 'content-type': 'application/json', ...(headers ?? {}) };
}

async function requestJson<T = Record<string, unknown>>(
  router: Hono,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ res: Response; data: T }> {
  const init = body === undefined
    ? { method, headers }
    : { method, headers: jsonHeaders(headers), body: JSON.stringify(body) };
  const res = await router.request(path, init);
  const data = await res.json() as T;
  return { res, data };
}

describe('Excubitor HTTP APIs', () => {
  let router: Hono;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.catalog = makeCatalog();
    mocks.serviceMap = {};
    mocks.domainRoot = '.example.test';
    mocks.identity = { siteUrl: 'https://infisical.example', environment: 'dev', clientId: 'client-id', clientSecret: 'secret' };
    resetFiles();
    resetDbClientForTests();
    closeDb();
    resetDbClientForTests();
    openDb(':memory:');
    seedDb();
    router = await bootRouter();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    closeDb();
    resetDbClientForTests();
  });

  const readCases: Array<{ name: string; path: string; key: string }> = [
    { name: 'serves Corpus manifest', path: '/.well-known/corpus-service.json', key: 'service' },
    { name: 'serves hub health', path: '/api/hub/health', key: 'status' },
    { name: 'serves hub summary', path: '/api/hub/summary', key: 'services_total' },
    { name: 'serves hub services', path: '/api/hub/services', key: 'services' },
    { name: 'serves hub apps', path: '/api/hub/apps', key: 'apps' },
    { name: 'serves hub errors', path: '/api/hub/errors', key: 'errors' },
    { name: 'serves system metadata', path: '/api/v1/system', key: 'service' },
    { name: 'serves topology env', path: '/api/v1/topology', key: 'env' },
    { name: 'serves services list', path: '/api/v1/services', key: 'services' },
    { name: 'serves service detail', path: '/api/v1/services/svc-a', key: 'code' },
    { name: 'serves service recent logs', path: '/api/v1/services/svc-a/logs/recent', key: 'logs' },
    { name: 'serves service liveness', path: '/api/v1/services/svc-a/liveness', key: 'series' },
    { name: 'serves error tasks', path: '/api/v1/error-tasks', key: 'tasks' },
    { name: 'serves filtered error tasks', path: '/api/v1/error-tasks?state=open', key: 'tasks' },
    { name: 'serves auto-fix runs', path: '/api/v1/auto-fix/runs', key: 'runs' },
    { name: 'serves error rules', path: '/api/v1/error-rules', key: 'rules' },
    { name: 'serves launch plan', path: '/api/v1/launch/plan', key: 'projects' },
    { name: 'serves service env config', path: '/api/v1/services/svc-a/env-config', key: 'status' },
    { name: 'serves projects view', path: '/api/v1/projects', key: 'projects' },
    { name: 'serves Infisical config', path: '/api/v1/config/infisical', key: 'identity' },
    { name: 'serves domain root config', path: '/api/v1/config/domain-root', key: 'domain_root' },
    { name: 'serves updates list', path: '/api/v1/updates?fetch=1', key: 'updates' },
    { name: 'serves service commits', path: '/api/v1/services/svc-a/commits', key: 'commits' },
    { name: 'serves service branches', path: '/api/v1/services/svc-a/branches', key: 'branches' },
    { name: 'serves service update status', path: '/api/v1/services/svc-a/update', key: 'available' },
    { name: 'serves discovery', path: '/api/v1/discovery', key: 'candidates' },
    { name: 'serves ports report', path: '/api/v1/ports', key: 'listeners' },
    { name: 'serves memory summary', path: '/api/v1/memory/summary', key: 'services' },
    { name: 'serves memory series', path: '/api/v1/memory/series?kind=service&key=svc-a', key: 'series' },
    { name: 'serves cross-service recent logs', path: '/api/v1/logs/recent?codes=svc-a', key: 'logs' },
    {
      name: 'queries historical logs',
      path: '/api/v1/logs/query?codes=svc-a&from=2026-01-01T00%3A00%3A00Z&to=2026-01-02T00%3A00%3A00Z',
      key: 'logs',
    },
    { name: 'serves LLM logs', path: '/api/v1/logs/llm?codes=svc-a', key: 'logs' },
    { name: 'serves releases list', path: '/api/v1/releases', key: 'releases' },
    { name: 'serves release detail', path: '/api/v1/releases/demo', key: 'manifest' },
    { name: 'serves reviews list', path: '/api/v1/reviews', key: 'items' },
    { name: 'serves review repo dates', path: '/api/v1/reviews/RepoA', key: 'dates' },
    { name: 'serves federation self', path: '/api/v1/federation/self', key: 'token' },
    { name: 'serves peers list', path: '/api/v1/peers', key: 'peers' },
  ];

  for (const c of readCases) {
    it(c.name, async () => {
      const { res, data } = await requestJson(router, 'GET', c.path);
      expect(res.status).toBe(200);
      expect(data).toHaveProperty(c.key);
    });
  }

  it('serves downtime summaries for liveness and project cards', async () => {
    const live = await requestJson<{
      downtime: { downtime_ms: number; incidents: number; uptime_ratio: number | null } | null;
    }>(router, 'GET', '/api/v1/services/svc-a/liveness?window_min=60');
    expect(live.res.status).toBe(200);
    expect(live.data.downtime).toMatchObject({ downtime_ms: 0, incidents: 0, uptime_ratio: 1 });

    const projects = await requestJson<{
      projects: Array<{ components: Array<{ code: string; downtime_24h?: { downtime_ms: number } | null }> }>;
    }>(router, 'GET', '/api/v1/projects');
    const svc = projects.data.projects.flatMap((p) => p.components).find((c) => c.code === 'svc-a');
    expect(svc?.downtime_24h).toMatchObject({ downtime_ms: 0 });
  });

  it('caches expensive discovery reads briefly', async () => {
    const first = await requestJson(router, 'GET', '/api/v1/discovery');
    const second = await requestJson(router, 'GET', '/api/v1/discovery');

    expect(first.res.status).toBe(200);
    expect(second.res.status).toBe(200);
    expect(mocks.discoverServices).toHaveBeenCalledTimes(1);
  });

  it('caches expensive port reports briefly', async () => {
    const first = await requestJson(router, 'GET', '/api/v1/ports');
    const second = await requestJson(router, 'GET', '/api/v1/ports');

    expect(first.res.status).toBe(200);
    expect(second.res.status).toBe(200);
    expect(mocks.buildPortReport).toHaveBeenCalledTimes(1);
  });

  it('serves review markdown files', async () => {
    const res = await router.request('/api/v1/reviews/RepoA/2026-01-01/REVIEW.md');
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toContain('# Review');
  });

  it('returns not_found for missing services across API groups', async () => {
    const services = await requestJson(router, 'GET', '/api/v1/services/missing');
    expect(services.res.status).toBe(404);

    const update = await requestJson(router, 'GET', '/api/v1/services/missing/update');
    expect(update.res.status).toBe(404);

    const envConfig = await requestJson(router, 'GET', '/api/v1/services/missing/env-config');
    expect(envConfig.res.status).toBe(404);
  });

  it('proxies function metrics from a service local port', async () => {
    const snapshot = {
      generatedAt: 123,
      totals: { calls: 1, ok: 1, errors: 0, totalMs: 12, avgMs: 12 },
      rows: [{
        key: 'svc-a',
        service: 'svc-a',
        domain: 'svc-a',
        kind: 'api',
        target: 'api.GET /health',
        calls: 1,
        ok: 1,
        errors: 0,
        totalMs: 12,
        avgMs: 12,
        minMs: 12,
        maxMs: 12,
        lastMs: 12,
        lastStatus: 'ok',
        lastAt: 123,
        errorNames: {},
      }],
    };
    const fetchMock = vi.fn(async (url: unknown) => {
      expect(String(url)).toBe('http://127.0.0.1:1234/v1/instrumentation/functions?limit=5&kind=api&sort=calls');
      return new Response(JSON.stringify(snapshot), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const metrics = await requestJson<{
      code: string;
      source_url: string;
      snapshot: typeof snapshot;
    }>(router, 'GET', '/api/v1/services/svc-a/function-metrics?limit=5&kind=api&sort=calls');

    expect(metrics.res.status).toBe(200);
    expect(metrics.data.code).toBe('svc-a');
    expect(metrics.data.source_url).toBe('http://127.0.0.1:1234/v1/instrumentation/functions?limit=5&kind=api&sort=calls');
    expect(metrics.data.snapshot.totals.calls).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not proxy function metrics for missing services', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const metrics = await requestJson(router, 'GET', '/api/v1/services/missing/function-metrics');

    expect(metrics.res.status).toBe(404);
    expect(metrics.data).toMatchObject({ error: 'service_not_found', code: 'missing' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('streams live log SSE endpoints', async () => {
    for (const path of ['/api/v1/services/svc-a/logs', '/api/v1/logs?codes=svc-a']) {
      const res = await router.request(path);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      await res.body?.cancel();
    }
  });

  it('mutates error management APIs', async () => {
    const triage = await requestJson(router, 'PATCH', '/api/v1/error-tasks/task-1', { state: 'ack', note: 'seen' });
    expect(triage.res.status).toBe(200);
    expect(triage.data).toMatchObject({ ok: true });

    const autoFix = await requestJson(router, 'POST', '/api/v1/error-tasks/task-1/auto-fix', {});
    expect(autoFix.res.status).toBe(200);
    expect(autoFix.data).toMatchObject({ ok: true, state: 'queued' });

    const investigate = await requestJson(router, 'POST', '/api/v1/error-tasks/task-1/investigate', {});
    expect(investigate.res.status).toBe(200);
    expect(investigate.data).toMatchObject({ ok: true, state: 'queued' });

    const rule = await requestJson(router, 'POST', '/api/v1/error-rules', {
      name: 'panic',
      pattern: 'panic',
      pattern_type: 'keyword',
      severity: 'warn',
      service_codes: ['svc-a'],
    });
    expect(rule.res.status).toBe(200);
    expect(rule.data).toHaveProperty('id');
  });

  it('validates and runs service control APIs', async () => {
    const invalid = await requestJson(router, 'POST', '/api/v1/services/svc-a/control', { action: 'bad' });
    expect(invalid.res.status).toBe(400);

    const started = await requestJson(router, 'POST', '/api/v1/services/svc-a/control', { action: 'start' });
    expect(started.res.status).toBe(200);
    expect(started.data).toMatchObject({ ok: true, action: 'start' });

    const disabled = await requestJson(router, 'POST', '/api/v1/services/disabled/control', { action: 'start' });
    expect(disabled.res.status).toBe(400);

    const emergency = await requestJson(router, 'POST', '/api/v1/services/svc-a/emergency', {
      action: 'kill-port',
      port: 1234,
    });
    expect(emergency.res.status).toBe(200);
    expect(emergency.data).toMatchObject({ ok: true, action: 'kill-port' });
  });

  it('mutates launch, env, and catalog APIs', async () => {
    const profile = await requestJson(router, 'PUT', '/api/v1/launch/profile', {
      selection: ['svc-a', 'app-a'],
      auto_launch: false,
    });
    expect(profile.res.status).toBe(200);
    expect(profile.data).toHaveProperty('profile');

    const preflight = await requestJson(router, 'POST', '/api/v1/launch/preflight', { codes: ['svc-a'] });
    expect(preflight.res.status).toBe(200);
    expect(preflight.data).toMatchObject({ ok: true, codes: ['svc-a'] });

    const start = await requestJson(router, 'POST', '/api/v1/launch/start', { codes: ['svc-a'] });
    expect(start.res.status).toBe(200);
    expect(start.data).toMatchObject({ ok: true, started: ['svc-a'] });

    const stop = await requestJson(router, 'POST', '/api/v1/launch/stop', { codes: ['svc-a'] });
    expect(stop.res.status).toBe(200);
    expect(stop.data).toHaveProperty('results');

    const corpus = await requestJson(router, 'PUT', '/api/v1/services/svc-a/corpus-pref', { uses_corpus: true });
    expect(corpus.res.status).toBe(200);
    expect(corpus.data).toMatchObject({ ok: true, uses_corpus: true });

    const env = await requestJson(router, 'PUT', '/api/v1/services/svc-a/env-config', {
      project_id: 'override-proj',
      environment: 'dev',
      inject: true,
      required_env: ['REQUIRED_ONE'],
    });
    expect(env.res.status).toBe(200);
    expect(env.data).toMatchObject({ ok: true, code: 'svc-a' });

    const catalogInfo = await requestJson(router, 'PUT', '/api/v1/services/svc-a/catalog-info', {
      project_code: 'proj-a',
      subdomain: 'svc-a',
      frontend_url: 'svc-a.example.test',
    });
    expect(catalogInfo.res.status).toBe(200);
    expect(catalogInfo.data).toMatchObject({ ok: true, updated: true });
  });

  it('mutates config and secret-agent APIs', async () => {
    const domain = await requestJson(router, 'PUT', '/api/v1/config/domain-root', { domain_root: 'example.org' });
    expect(domain.res.status).toBe(200);
    expect(domain.data).toHaveProperty('domain_root');

    const identity = await requestJson(router, 'PUT', '/api/v1/config/infisical/identity', {
      siteUrl: 'https://infisical.local',
      environment: 'dev',
      clientId: 'cid',
      clientSecret: 'secret',
    });
    expect(identity.res.status).toBe(200);
    expect(identity.data).toHaveProperty('identity');

    const test = await requestJson(router, 'POST', '/api/v1/config/infisical/test', {});
    expect(test.res.status).toBe(200);
    expect(test.data).toMatchObject({ ok: true });

    const services = await requestJson(router, 'PUT', '/api/v1/config/infisical/services', {
      services: {
        'svc-a': { project_id: 'proj', environment: 'dev', inject: true, prefix: '' },
      },
    });
    expect(services.res.status).toBe(200);
    expect(services.data).toHaveProperty('services');

    const unauthorized = await requestJson(router, 'POST', '/api/v1/secrets/resolve', { service: 'svc-a' });
    expect(unauthorized.res.status).toBe(401);

    const resolved = await requestJson(
      router,
      'POST',
      '/api/v1/secrets/resolve',
      { service: 'svc-a', keys: ['REQUIRED_ONE'] },
      { authorization: 'Bearer good' },
    );
    expect(resolved.res.status).toBe(200);
    expect(resolved.data).toHaveProperty('secrets');
  });

  it('mutates update, discovery, and release APIs', async () => {
    const update = await requestJson(router, 'POST', '/api/v1/services/svc-a/update', {
      install: false,
      restart: false,
    });
    expect(update.res.status).toBe(200);
    expect(update.data).toMatchObject({ ok: true, code: 'svc-a' });

    const scan = await requestJson(router, 'POST', '/api/v1/discovery/scan', {});
    expect(scan.res.status).toBe(200);
    expect(scan.data).toMatchObject({ written: 1, catalog_total: 3 });

    const build = await requestJson(router, 'POST', '/api/v1/releases/demo/build', {
      skipBuild: true,
      skipInstall: true,
      skipArchive: true,
    });
    expect(build.res.status).toBe(200);
    expect(build.data).toMatchObject({ ok: true, archive: 'demo.zip' });
  });

  it('protects and mutates federation APIs', async () => {
    const unauthorized = await requestJson(router, 'GET', '/api/v1/federation/node');
    expect(unauthorized.res.status).toBe(401);

    const node = await requestJson(router, 'GET', '/api/v1/federation/node', undefined, { authorization: 'Bearer good' });
    expect(node.res.status).toBe(200);
    expect(node.data).toHaveProperty('summary');

    const localControl = await requestJson(
      router,
      'POST',
      '/api/v1/federation/control',
      { code: 'svc-a', action: 'restart' },
      { authorization: 'Bearer good', 'x-excubitor-peer': 'peer-a' },
    );
    expect(localControl.res.status).toBe(200);
    expect(localControl.data).toMatchObject({ ok: true, action: 'restart' });

    const localUpdate = await requestJson(
      router,
      'POST',
      '/api/v1/federation/update',
      { code: 'svc-a', install: false, restart: false },
      { authorization: 'Bearer good' },
    );
    expect(localUpdate.res.status).toBe(200);
    expect(localUpdate.data).toMatchObject({ ok: true, code: 'svc-a' });

    const created = await requestJson<{ ok: boolean; peer: { id: string } }>(router, 'POST', '/api/v1/peers', {
      name: 'Remote A',
      base_url: 'https://remote.example/',
      token: 'remote-token',
      enabled: true,
    });
    expect(created.res.status).toBe(201);
    const peerId = created.data.peer.id;

    const patched = await requestJson(router, 'PATCH', `/api/v1/peers/${peerId}`, { name: 'Remote B' });
    expect(patched.res.status).toBe(200);
    expect(patched.data).toHaveProperty('peer');

    const tested = await requestJson(router, 'POST', `/api/v1/peers/${peerId}/test`, {});
    expect(tested.res.status).toBe(200);
    expect(tested.data).toMatchObject({ ok: true, node: 'remote-a' });

    const aggregate = await requestJson(router, 'GET', '/api/v1/federation/services');
    expect(aggregate.res.status).toBe(200);
    expect(aggregate.data).toHaveProperty('peers');

    const remoteControl = await requestJson(router, 'POST', `/api/v1/peers/${peerId}/services/remote-svc/control`, {
      action: 'start',
    });
    expect(remoteControl.res.status).toBe(200);
    expect(remoteControl.data).toMatchObject({ ok: true });

    const remoteUpdate = await requestJson(router, 'POST', `/api/v1/peers/${peerId}/services/remote-svc/update`, {
      install: false,
      restart: false,
    });
    expect(remoteUpdate.res.status).toBe(200);
    expect(remoteUpdate.data).toMatchObject({ ok: true });

    const deleted = await requestJson(router, 'DELETE', `/api/v1/peers/${peerId}`);
    expect(deleted.res.status).toBe(200);
    expect(deleted.data).toMatchObject({ ok: true });
  });
});
