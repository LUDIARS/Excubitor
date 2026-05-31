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

