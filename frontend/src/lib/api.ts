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

export function saveServices(services: Record<string, ServiceInfisical>) {
  return putJSON<{ ok: boolean; services: Record<string, ServiceInfisical> }>(
    '/api/v1/config/infisical/services',
    { services },
  );
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

