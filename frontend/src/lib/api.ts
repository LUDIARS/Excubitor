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
  disabled?: boolean;
  description?: string | null;
  component: string | null;
  project_code?: string | null;
  runtime: string | null;
  state: string;
  port: number | null;
  frontend_port?: number | null;
  backend_port?: number | null;
  ports?: Array<{ role: string; port: number; env?: string | null }>;
  frontend_url?: string | null;
  subdomain?: string | null;
  domain?: string | null;
  git: GitInfo;
  package_version: string | null;
  monitor_only: boolean;
  host: Host | null;
  last_seen_at: number | null;
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
  role: string;
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
export type EmergencyAction = 'kill-port' | 'claude-port-fix';

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
  kind: 'cwd' | 'compose_file' | 'infisical' | 'env' | 'start_script' | 'port' | 'disabled';
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
  required_env?: string[];
}

export interface ServiceEnvStatus {
  ready: boolean;
  required: string[];
  missing: string[];
  resolvedKeys: number | null;
  error: string | null;
}

export interface ServiceEnvConfig {
  code: string;
  catalog: ServiceInfisical | null;
  override: ServiceInfisical | null;
  effective: ServiceInfisical | null;
  required_env: string[];
  status: ServiceEnvStatus;
}

export interface ServiceEnvConfigInput {
  project_id?: string | null;
  environment?: string;
  inject?: boolean;
  prefix?: string;
  include?: string[];
  exclude?: string[];
  required_env?: string[];
}

export interface DomainRootStatus {
  value: string;
  source: 'env' | 'config' | 'unset';
  configured: boolean;
  env: string | null;
  default_value: string;
  storePath: string;
}

export interface ConfigInfisical {
  identity: IdentityStatus;
  services: Record<string, ServiceInfisical>;
  domain_root: DomainRootStatus;
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

export interface EmergencyResult {
  ok: boolean;
  action: EmergencyAction;
  code: string;
  port: number | null;
  pids: number[];
  stdout: string;
  stderr: string;
  prompt?: string;
}

export function emergencyService(code: string, action: EmergencyAction, prompt?: string, port?: number) {
  return postJSON<EmergencyResult>(
    `/api/v1/services/${encodeURIComponent(code)}/emergency`,
    { action, prompt, port },
  );
}

export interface RecentLogLine {
  id: string | number;
  ts: number | string;
  level: string | null;
  code?: string;
  line: string;
}

export function fetchRecentLogs(code: string, limit = 80): Promise<RecentLogLine[]> {
  return getJSON<{ logs: RecentLogLine[] }>(
    `/api/v1/services/${encodeURIComponent(code)}/logs/recent?limit=${limit}`,
  ).then((d) => d.logs);
}

export function fetchAllRecentLogs(codes: string[] = [], limit = 500): Promise<RecentLogLine[]> {
  const q = new URLSearchParams({ limit: String(limit) });
  if (codes.length > 0) q.set('codes', codes.join(','));
  return getJSON<{ logs: RecentLogLine[] }>(`/api/v1/logs/recent?${q.toString()}`).then((d) => d.logs);
}

export interface VgLogLine {
  ts: number;
  service_code: string;
  channel: string;
  level?: string | null;
  line?: string;
  message?: string;
  text?: string;
  [key: string]: unknown;
}

export function fetchVgLogs(codes: string[] = [], limit = 500): Promise<VgLogLine[]> {
  const q = new URLSearchParams({ limit: String(limit) });
  if (codes.length > 0) q.set('codes', codes.join(','));
  return getJSON<{ logs: VgLogLine[] }>(`/api/v1/logs/llm?${q.toString()}`).then((d) => d.logs);
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

export function fetchServiceEnvConfig(code: string): Promise<ServiceEnvConfig> {
  return getJSON<ServiceEnvConfig>(`/api/v1/services/${encodeURIComponent(code)}/env-config`);
}

export function saveServiceEnvConfig(code: string, input: ServiceEnvConfigInput) {
  return putJSON<ServiceEnvConfig & { ok: boolean }>(
    `/api/v1/services/${encodeURIComponent(code)}/env-config`,
    input,
  );
}

export function saveDomainRoot(domainRoot: string) {
  return putJSON<{ ok: boolean; domain_root: DomainRootStatus }>('/api/v1/config/domain-root', {
    domain_root: domainRoot,
  });
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

// ─── scan (自動カタログ生成) ───
export interface ScanResult {
  created: string[];
  ports: Record<string, number>;
  skipped: Array<{ name: string; reason: string }>;
  scannedRoot: string;
  catalog_total: number;
}

/** 未登録 repo を解析し、 実行可能なものを services.auto.yaml に自動生成 (port も検出)。 */
export function scanCatalog(): Promise<ScanResult> {
  return postJSON<ScanResult>('/api/v1/discovery/scan', {});
}

// ─── liveness (稼働率) ───
export interface LivenessSeries {
  code: string;
  window_min: number;
  uptime_ratio: number | null;
  series: Array<{ t: number; ok: number }>;
}

/** サービスの稼働率時系列 (liveness_history の ok 1/0) + uptime 比率。 */
export function fetchLiveness(code: string, windowMin = 120): Promise<LivenessSeries> {
  return getJSON<LivenessSeries>(`/api/v1/services/${encodeURIComponent(code)}/liveness?window_min=${windowMin}`);
}

export function fetchTopology(): Promise<Record<string, string>> {
  return getJSON<{ env: Record<string, string> }>('/api/v1/topology').then((d) => d.env);
}

export interface SystemInfo {
  service: string;
  safe_mode: boolean;
  service_mode?: boolean;
  build_version?: {
    project_code: string;
    major: number;
    minor: number;
    patch: number;
    version: string;
    patch_source: 'env' | 'git' | 'fallback';
    git_hash: string | null;
  } | null;
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
  target_kind: 'service' | 'wsl' | 'host';
  target_key: string;
  name: string;
  primary_source: string;
  rss_bytes: number | null;
  heap_used_bytes: number | null;
  heap_total_bytes: number | null;
  external_bytes: number | null;
  array_buffers_bytes: number | null;
  cpu_pct: number | null;
  pid: number | null;
  detail: Record<string, unknown> | null;
  sampled_at: number;
  leak: MemoryLeak;
  budget: {
    rss_budget_bytes: number | null;
    cpu_budget_pct: number | null;
    rss_ok: boolean | null;
    cpu_ok: boolean | null;
    ok: boolean | null;
  };
  spark: Array<{ t: number; rss: number }>;
  cpu_spark: Array<{ t: number; cpu: number }>;
}

export interface MemorySummary {
  services: MemoryCard[];
  wsl: MemoryCard[];
  host: MemoryCard | null;
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
  cpu: number | null;
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

export interface CatalogInfoInput {
  project_code?: string | null;
  subdomain?: string | null;
  frontend_url?: string | null;
}

export function saveCatalogInfo(code: string, input: CatalogInfoInput) {
  return putJSON<{ ok: boolean; code: string }>(
    `/api/v1/services/${encodeURIComponent(code)}/catalog-info`,
    input,
  );
}

// ─────────────── Branch status (ブランチ状況) ───────────────
export interface BranchInfo {
  name: string;
  current: boolean;
  remote: boolean;
}

export interface BranchStatus {
  code: string;
  repoDir: string | null;
  current: string | null;
  dirty: boolean;
  ahead: number;
  behind: number;
  branches: BranchInfo[];
  note: string | null;
}

export function fetchBranchStatus(code: string): Promise<BranchStatus> {
  return getJSON<BranchStatus>(`/api/v1/services/${encodeURIComponent(code)}/branches`);
}

// ─────────────── Federation (他拠点連携) ───────────────
export interface PeerView {
  id: string;
  name: string;
  base_url: string;
  token_hint: string;
  cf_access_id: string | null;
  cf_secret_hint: string | null;
  enabled: boolean;
  last_ok_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface NodeService {
  code: string;
  name: string;
  state: string;
  port: number | null;
  git_branch: string | null;
}

export interface NodeSummary {
  service: string;
  services_total: number;
  up: number;
  down: number;
  unknown: number;
  open_errors: number;
}

export interface NodeHost {
  used_mem_bytes?: number | null;
  cpu_pct?: number | null;
  totalMemBytes?: number;
  freeMemBytes?: number;
  cpuCount?: number;
  sampled_at?: number;
}

export interface FederationNode {
  peer_id: string | null;
  name: string;
  base_url: string | null;
  ok: boolean;
  error: string | null;
  node?: string;
  summary: NodeSummary | null;
  services: NodeService[];
  host: NodeHost | null;
}

export interface FederationView {
  local: FederationNode;
  peers: FederationNode[];
}

export function fetchPeers(): Promise<PeerView[]> {
  return getJSON<{ peers: PeerView[] }>('/api/v1/peers').then((d) => d.peers);
}

export function addPeer(input: {
  name: string;
  base_url: string;
  token: string;
  cf_access_id?: string;
  cf_access_secret?: string;
}) {
  return postJSON<{ ok: boolean; peer: PeerView }>('/api/v1/peers', input);
}

export function updatePeer(
  id: string,
  patch: { name?: string; base_url?: string; token?: string; cf_access_id?: string; cf_access_secret?: string; enabled?: boolean },
) {
  return patchJSON<{ ok: boolean; peer: PeerView }>(`/api/v1/peers/${encodeURIComponent(id)}`, patch);
}

export function deletePeer(id: string) {
  return fetch(`/api/v1/peers/${encodeURIComponent(id)}`, { method: 'DELETE' }).then((r) => r.json());
}

export function testPeer(id: string) {
  return postJSON<{ ok: boolean; status: number | null; error: string | null; node: string | null }>(
    `/api/v1/peers/${encodeURIComponent(id)}/test`,
    {},
  );
}

export function fetchFederation(): Promise<FederationView> {
  return getJSON<FederationView>('/api/v1/federation/services');
}

export function remoteControl(peerId: string, code: string, action: ControlAction) {
  return postJSON<{ ok: boolean; status: number | null; error: string | null; result: unknown }>(
    `/api/v1/peers/${encodeURIComponent(peerId)}/services/${encodeURIComponent(code)}/control`,
    { action },
  );
}

/** リモートピアの 1 サービスを pull (更新) する (federation プロキシ)。 */
export function remoteUpdate(peerId: string, code: string, opts: { install?: boolean; restart?: boolean } = {}) {
  return postJSON<{ ok: boolean; status: number | null; error: string | null; result: unknown }>(
    `/api/v1/peers/${encodeURIComponent(peerId)}/services/${encodeURIComponent(code)}/update`,
    opts,
  );
}

// ─────────────── このノードの identity (federation token) ───────────────
export interface SelfNode {
  node: string;
  token: string;
}

/** 本ノードの federation 名 + agent token。 ピアに貼り付けて登録するための導線。 */
export function fetchSelfNode(): Promise<SelfNode> {
  return getJSON<SelfNode>('/api/v1/federation/self');
}

