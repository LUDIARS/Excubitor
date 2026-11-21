import type { LaunchIntent, ResourceObservation } from './job-types.js';
import type { ComputeTarget } from './target-schema.js';

export interface ComputeProvider {
  prepare(intent: LaunchIntent): Promise<() => Promise<string>>;
  reconcile(token: string, tags: Record<string, string>): Promise<ResourceObservation | null>;
  describe(resource: string): Promise<ResourceObservation | null>;
  stop(resource: string): Promise<void>;
  inventory(owner: string, cursor?: string): Promise<{ resources: ResourceObservation[]; cursor?: string }>;
}

export type ProviderFactory = (target: ComputeTarget) => Promise<ComputeProvider>;

export function resourceTime(iso: string | undefined): number | null {
  const time = Date.parse(iso ?? '');
  return Number.isFinite(time) ? time : null;
}
