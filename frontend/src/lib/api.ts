// ─────────────── Types ───────────────
export interface Host {
  hostname: string;
  name: string;
}

export interface GitInfo {
  branch: string | null;
  hash: string | null;
  dirty: boolean | null;
}

export interface Component {
  code: string;
  name: string;
  component: string | null;
  runtime: string | null;
  state: string;
  port: number | null;
  git: GitInfo;
  package_version: string | null;
  monitor_only: boolean;
  host: Host | null;
  last_seen_at: string | null;
  docker_id: string | null;
  /** Vestigium JSONL ログを持つか (バッジ表示用)。 */
  has_vestigium?: boolean;
  log_path?: string | null;
  autostart?: boolean;
  /** 起動スクリプト (start-*.bat) のパス (あれば)。 */
  start_script?: string | null;
  /** Corpus を利用するか (実効値)。 */
  uses_corpus?: boolean;
  tier?: string;
}

// ─────────────── Commits (最近の更新内容) ───────────────
export interface CommitInfo {
  hash: string;
  subject: string;
  author: string;
  date: string;
  relative: string;
}

// ─────────────── Ports (ポート衝突検知) ───────────────
export interface PortListener {
  port: number;
  pids: number[];
  processNames: string[];
}
export interface DeclaredConflict {
  port: number;
  codes: string[];
}
export interface ServicePortStatus {
  code: string;
  name: string;
  port: number;
  state: string;
  listening: boolean;
  pids: number[];
  processNames: string[];
  conflict: boolean;
}
export interface PortReport {
  listeners: PortListener[];
  declaredConflicts: DeclaredConflict[];
  services: ServicePortStatus[];
  hasConflict: boolean;
}

// ─────────────── Updates (アップデート確認/配信) ───────────────
export interface UpdateStatus {
  code: string;
  repoDir: string | null;
  branch: string | null;
  behind: number;
  ahead: number;
  dirty: boolean;
  available: boolean;
  note: string | null;
  fetched: boolean;
}

export interface ApplyStep {
  step: string;
  ok: boolean;
  detail: string;
}

export interface ApplyResult {
  code: string;
  ok: boolean;
  steps: ApplyStep[];
}

// ─────────────── Discovery (新規サービス検出) ───────────────
export interface DiscoveredRepo {
  name: string;
  path: string;
  hasPackageJson: boolean;
  hasComposeFile: boolean;
  hasDevScript: boolean;
  suggestedRuntime: 'node' | 'docker-compose' | 'unknown';
  remote: string | null;
}

export interface MissingService {
  code: string;
  repoDir: string;
}

export interface DiscoveryResult {
  candidates: DiscoveredRepo[];
  missing: MissingService[];
  scannedRoot: string;
}

export interface Project {
  project_code: string;
  project_name: string;
  components: Component[];
}

export type ControlAction = 'start' | 'stop' | 'restart';

export interface ErrorTask {
  id: string;
  rule_id: string | null;
  service_instance_id: string | null;
  service_code: string | null;
  service_name: string | null;
  severity: string;
  summary: string;
  log_excerpt: string | null;
  occurrence_count: number;
  first_seen_at: string;
  last_seen_at: string;
  state: string;
  snooze_until: string | null;
  triaged_by: string | null;
  triaged_at: string | null;
  note: string | null;
  auto_fix_state: string | null;
  auto_fix_attempts: number;
  auto_fix_run_id: string | null;
}

export type AutoFixActionType = 'fix' | 'investigate';

export interface AutoFixRun {
  id: string;
  error_task_id: string;
  service_code: string;
  state: string;
  /** 'fix' = branch + commit + push + PR、E'investigate' = 解析�Eみ (= 既宁E'fix') */
  action_type: AutoFixActionType;
  triggered_by: string | null;
  branch: string | null;
  commit_hash: string | null;
  pr_url: string | null;
  verify_result: string | null;
  exit_code: number | null;
  error_message: string | null;
  stdout_tail: string | null;
  stderr_tail: string | null;
  prompt: string | null;
  started_at: string | null;
  finished_at: string | null;
}

// ─────────────── Launcher (起動セット) ───────────────
export interface PlanService {
  code: string;
  name: string;
  project_code: string;
  component: string | null;
  runtime: string;
  port: number | null;
  monitor_only: boolean;
  startable: boolean;
  start_tier: number;
  state: string;
  selected: boolean;
}

export interface PlanProject {
  project_code: string;
  services: PlanService[];
}

export interface LaunchProfile {
  configured: boolean;
  auto_launch: boolean;
  selection: string[];
  updated_at: number | null;
}

export interface LaunchPlan {
  profile: LaunchProfile;
  projects: PlanProject[];
}

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface PreflightCheck {
  kind: 'cwd' | 'compose_file' | 'infisical';
  status: CheckStatus;
  detail: string;
}

export interface ServicePreflight {
  code: string;
  name: string;
  ready: boolean;
  injectedKeys: number;
  checks: PreflightCheck[];
}

export interface PreflightReport {
  ok: boolean;
  identityPresent: boolean;
  needsIdentity: boolean;
  services: ServicePreflight[];
}

export interface LaunchItemResult {
  code: string;
  ok: boolean;
  skipped: boolean;
  message: string;
}

export interface LaunchResult {
  preflight: PreflightReport;
  results: LaunchItemResult[];
}

// ─────────────── Config (Infisical 設定) ───────────────
export interface IdentityStatus {
  configured: boolean;
  siteUrl: string | null;
  environment: string | null;
  clientIdHint: string | null;
  storePath: string;
}

export interface ServiceInfisical {
  project_id: string;
  environment: string;
  inject: boolean;
  prefix: string;
  include?: string[];
  exclude?: string[];
}

export interface ConfigInfisical {
  identity: IdentityStatus;
  services: Record<string, ServiceInfisical>;
}

export interface IdentityInput {
  siteUrl: string;
  environment?: string;
  clientId: string;
  clientSecret: string;
}

// ─────────────── API helpers ───────────────
async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return (await res.json()) as T;
}

async function postJSON<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.json()) as T;
}

async function putJSON<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return (await res.json()) as T;
}

async function patchJSON<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.json()) as T;
}

// ─────────────── endpoints ───────────────
export function fetchProjects(): Promise<Project[]> {
  return getJSON<{ projects: Project[] }>('/api/v1/projects').then((d) => d.projects);
}

export interface CatalogService {
  code: string;
  name: string;
}

/** catalog に登録済みの service code 一覧 (Config の service code 選択用)。 */
export function fetchCatalogServices(): Promise<CatalogService[]> {
  return getJSON<{ services: Array<{ code: string; name: string }> }>('/api/v1/services')
    .then((d) => d.services.map((s) => ({ code: s.code, name: s.name })));
}

export function controlService(code: string, action: ControlAction) {
  return postJSON<{ ok: boolean; exit_code: number; command: string; stdout: string; stderr: string }>(
    `/api/v1/services/${encodeURIComponent(code)}/control`,
    { action },
  );
}

export function fetchErrorTasks(state?: string): Promise<ErrorTask[]> {
  const q = state ? `?state=${encodeURIComponent(state)}` : '';
  return getJSON<{ tasks: ErrorTask[] }>(`/api/v1/error-tasks${q}`).then((d) => d.tasks);
}

export function triageErrorTask(id: string, body: { state?: string; note?: string; snooze_until?: string }) {
  return patchJSON<{ ok: boolean }>(`/api/v1/error-tasks/${id}`, body);
}

export function triggerAutoFix(id: string) {
  return postJSON<{ ok: boolean; runId?: string; state?: string; error?: string; message?: string }>(
    `/api/v1/error-tasks/${id}/auto-fix`,
    {},
  );
}

export function triggerInvestigate(id: string) {
  return postJSON<{ ok: boolean; runId?: string; state?: string; error?: string; message?: string }>(
    `/api/v1/error-tasks/${id}/investigate`,
    {},
  );
}

export function fetchAutoFixRuns(errorTaskId?: string): Promise<AutoFixRun[]> {
  const q = errorTaskId ? `?error_task_id=${encodeURIComponent(errorTaskId)}` : '';
  return getJSON<{ runs: AutoFixRun[] }>(`/api/v1/auto-fix/runs${q}`).then((d) => d.runs);
}

export function fetchLaunchPlan(): Promise<LaunchPlan> {
  return getJSON<LaunchPlan>('/api/v1/launch/plan');
}

export function saveLaunchProfile(selection: string[], autoLaunch: boolean) {
  return putJSON<{ ok: boolean; profile: LaunchProfile }>('/api/v1/launch/profile', {
    selection,
    auto_launch: autoLaunch,
  });
}

export function runPreflight(codes?: string[]): Promise<PreflightReport> {
  return postJSON<PreflightReport>('/api/v1/launch/preflight', codes ? { codes } : {});
}

export function launchStart(codes?: string[]): Promise<LaunchResult> {
  return postJSON<LaunchResult>('/api/v1/launch/start', codes ? { codes } : {});
}

export function launchStop(codes?: string[]): Promise<{ results: LaunchItemResult[] }> {
  return postJSON<{ results: LaunchItemResult[] }>('/api/v1/launch/stop', codes ? { codes } : {});
}

export function fetchConfig(): Promise<ConfigInfisical> {
  return getJSON<ConfigInfisical>('/api/v1/config/infisical');
}

export function saveIdentity(input: IdentityInput) {
  return putJSON<{ ok: boolean; identity: IdentityStatus }>('/api/v1/config/infisical/identity', input);
}

export function testIdentity() {
  return postJSON<{ ok: boolean; message: string }>('/api/v1/config/infisical/test', {});
}

export function saveServices(services: Record<string, ServiceInfisical>) {
  return putJSON<{ ok: boolean; services: Record<string, ServiceInfisical> }>(
    '/api/v1/config/infisical/services',
    { services },
  );
}

// ─── updates / discovery ───
export function fetchUpdates(fetch = false): Promise<UpdateStatus[]> {
  return getJSON<{ updates: UpdateStatus[] }>(`/api/v1/updates${fetch ? '?fetch=1' : ''}`).then((d) => d.updates);
}

export function applyUpdate(code: string, opts: { install?: boolean; restart?: boolean } = {}) {
  return postJSON<ApplyResult>(`/api/v1/services/${encodeURIComponent(code)}/update`, opts);
}

export function fetchDiscovery(): Promise<DiscoveryResult> {
  return getJSON<DiscoveryResult>('/api/v1/discovery');
}

export function fetchTopology(): Promise<Record<string, string>> {
  return getJSON<{ env: Record<string, string> }>('/api/v1/topology').then((d) => d.env);
}

export interface SystemInfo {
  service: string;
  safe_mode: boolean;
}

export function fetchSystem(): Promise<SystemInfo> {
  return getJSON<SystemInfo>('/api/v1/system');
}

// ─────────────── Memory (メモリ監視) ───────────────
export type LeakVerdict = 'insufficient' | 'ok' | 'suspect' | 'leaking';

export interface MemoryLeak {
  verdict: LeakVerdict;
  slopeBytesPerHour: number;
  monotonicRatio: number;
  baselineBytes: number | null;
  latestBytes: number | null;
  samples: number;
  spanMs: number;
}

export interface MemoryCard {
  target_kind: 'service' | 'wsl';
  target_key: string;
  name: string;
  primary_source: string;
  rss_bytes: number | null;
  heap_used_bytes: number | null;
  heap_total_bytes: number | null;
  external_bytes: number | null;
  array_buffers_bytes: number | null;
  pid: number | null;
  detail: Record<string, unknown> | null;
  sampled_at: number;
  leak: MemoryLeak;
  spark: Array<{ t: number; rss: number }>;
}

export interface MemorySummary {
  services: MemoryCard[];
  wsl: MemoryCard[];
}

export function fetchMemorySummary(): Promise<MemorySummary> {
  return getJSON<MemorySummary>('/api/v1/memory/summary');
}

export interface MemorySeriesPoint {
  t: number;
  rss: number | null;
  heap_used: number | null;
  heap_total: number | null;
  external: number | null;
  array_buffers: number | null;
}

export function fetchMemorySeries(
  kind: string,
  key: string,
  windowMin = 120,
  source?: string,
): Promise<MemorySeriesPoint[]> {
  const q = new URLSearchParams({ kind, key, window_min: String(windowMin) });
  if (source) q.set('source', source);
  return getJSON<{ series: MemorySeriesPoint[] }>(`/api/v1/memory/series?${q.toString()}`).then((d) => d.series);
}

// SSE log stream を購読する、Eunsubscribe 関数を返す、E
export function subscribeLogs(
  code: string,
  onLine: (line: { channel: string; ts: string; line: string }) => void,
): () => void {
  const es = new EventSource(`/api/v1/services/${encodeURIComponent(code)}/logs`);
  es.addEventListener('log', (e: MessageEvent) => {
    try {
      onLine(JSON.parse(e.data) as { channel: string; ts: string; line: string });
    } catch {
      /* ignore */
    }
  });
  return () => es.close();
}

/** 全サービス横断のライブログを購読する (codes 省略で全件)。 行に code が付く。 */
export function subscribeAllLogs(
  onLine: (line: { code: string; channel: string; ts: string; line: string }) => void,
  codes?: string[],
): () => void {
  const q = codes && codes.length > 0 ? `?codes=${encodeURIComponent(codes.join(','))}` : '';
  const es = new EventSource(`/api/v1/logs${q}`);
  es.addEventListener('log', (e: MessageEvent) => {
    try {
      onLine(JSON.parse(e.data) as { code: string; channel: string; ts: string; line: string });
    } catch {
      /* ignore */
    }
  });
  return () => es.close();
}

// ─── commits / ports / corpus-pref ───
export function fetchCommits(code: string, limit = 5): Promise<CommitInfo[]> {
  return getJSON<{ commits: CommitInfo[] }>(
    `/api/v1/services/${encodeURIComponent(code)}/commits?limit=${limit}`,
  ).then((d) => d.commits);
}

export function fetchPorts(): Promise<PortReport> {
  return getJSON<PortReport>('/api/v1/ports');
}

export function setCorpusPref(code: string, usesCorpus: boolean | null) {
  return putJSON<{ ok: boolean; code: string; uses_corpus: boolean | null }>(
    `/api/v1/services/${encodeURIComponent(code)}/corpus-pref`,
    { uses_corpus: usesCorpus },
  );
}

