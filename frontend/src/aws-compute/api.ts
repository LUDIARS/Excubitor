export interface ComputeTarget {
  id: string;
  name: string;
  kind: 'ec2' | 'fargate';
  region: string;
  maxRuntimeSeconds: number;
  orphanPolicy: 'report' | 'terminate';
}

export interface ComputeJob {
  operation_id: string;
  job_id: string;
  target_id: string;
  submission: string;
  provider_state: string | null;
  release: 'pending' | 'requested' | 'confirmed' | 'not_allocated';
  deadline: string;
  issue: string | null;
  containers: Array<{ name: string; exit_code: number | null }>;
}

interface Sweep {
  completed_at: string;
  errors: number;
  expired: number;
  resources: Array<{ resource_id: string; target_id: string; expires_at: string; action: string }>;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1/aws-compute${path}`, { ...init, cache: 'no-store' });
  if (response.status === 204) return undefined as T;
  const body = await response.json();
  if (!response.ok) {
    const fields = Array.isArray(body.fields) ? body.fields.filter(Boolean).join(', ') : '';
    throw new Error(fields ? `${body.error} (${fields})` : body.error ?? `HTTP ${response.status}`);
  }
  return body as T;
}

export const listTargets = (signal: AbortSignal) =>
  request<{ targets: ComputeTarget[]; credentials: { configured: boolean } }>('/targets', { signal });
export const listJobs = (signal: AbortSignal, active: boolean) =>
  request<{ jobs: ComputeJob[] }>(`/jobs?active=${active}&limit=50`, { signal });
export const readSweep = (signal: AbortSignal) => request<{ sweep: Sweep | null }>('/orphans', { signal });

export const saveTarget = (id: string, input: unknown) =>
  request<{ target: ComputeTarget }>(`/targets/${encodeURIComponent(id)}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  });
export const deleteTarget = (id: string) =>
  request<void>(`/targets/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const stopJob = (id: string) =>
  request<ComputeJob>(`/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
