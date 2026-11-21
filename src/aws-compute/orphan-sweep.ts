import type { JobJournal } from './job-journal.js';
import type { ResourceObservation } from './job-types.js';
import type { ProviderFactory } from './provider.js';
import type { ComputeRegistry } from './registry.js';
import { EXPIRY_TAG, isExpiredOwnedResource, matchesJobTags, OPERATION_TAG, OWNER_TAG, TARGET_TAG } from './resource-tags.js';
import type { ComputeTarget } from './target-schema.js';

const SWEEP_INTERVAL = 5 * 60_000;
const MAX_PAGES_PER_SCOPE = 100;
const MAX_REPORTED = 100;

export interface OrphanReceipt {
  resource_id: string;
  target_id: string;
  expires_at: string;
  action: 'reported' | 'stop_requested' | 'stop_failed';
}

export function inventoryScope(target: ComputeTarget): string {
  return target.kind === 'ec2' ? `ec2:${target.region}` : target.cluster;
}

export class OrphanSweep {
  private nextScan = 0;
  private iterator: AsyncGenerator<void> | undefined;
  private lastScan: { completed_at: string; errors: number; expired: number; resources: OrphanReceipt[] } | null = null;

  constructor(
    private readonly registry: ComputeRegistry,
    private readonly journal: JobJournal,
    private readonly provider: ProviderFactory,
    private readonly now: () => number = Date.now,
  ) {}

  report() {
    return this.lastScan;
  }

  async step(): Promise<void> {
    if (!this.iterator && this.now() >= this.nextScan) this.iterator = this.scan(this.registry.list());
    if (!this.iterator) return;
    if ((await this.iterator.next()).done) {
      this.iterator = undefined;
      this.nextScan = this.now() + SWEEP_INTERVAL;
    }
  }

  async *scan(targets: ComputeTarget[]): AsyncGenerator<void> {
    if (targets.length === 0) {
      this.lastScan = null;
      return;
    }
    const owner = this.registry.owner();
    const byId = new Map(targets.map((target) => [target.id, target]));
    const byScope = new Map(targets.map((target) => [inventoryScope(target), target]));
    const resources: OrphanReceipt[] = [];
    let errors = 0;
    let expired = 0;
    for (const [scope, target] of byScope) {
      let cursor: string | undefined;
      try {
        for (let count = 0; count < MAX_PAGES_PER_SCOPE; count++) {
          const client = await this.provider(target);
          const page = await client.inventory(owner, cursor);
          yield; // A large cluster never holds the lifecycle worker for an entire scan.
          for (const resource of page.resources) {
            if (!this.isOrphan(resource, owner, scope)) continue;
            expired++;
            const id = resource.tags[TARGET_TAG]!;
            const previous = byId.get(id);
            const current = this.registry.get(id);
            let action: OrphanReceipt['action'] = 'reported';
            if (!resource.stopping && previous?.orphanPolicy === 'terminate' && current?.orphanPolicy === 'terminate'
              && inventoryScope(current) === scope) {
              try {
                const latest = await client.describe(resource.id);
                const configured = this.registry.get(id);
                if (latest?.id === resource.id && latest.tags[TARGET_TAG] === id && !latest.stopping
                  && configured?.orphanPolicy === 'terminate' && inventoryScope(configured) === scope
                  && this.isOrphan(latest, owner, scope)) {
                  await client.stop(resource.id);
                  action = 'stop_requested';
                }
              } catch {
                action = 'stop_failed';
                errors++;
              }
              yield;
            }
            if (resources.length < MAX_REPORTED) {
              resources.push({ resource_id: resource.id, target_id: id, expires_at: resource.tags[EXPIRY_TAG]!, action });
            }
          }
          cursor = page.cursor;
          if (!cursor) break;
        }
        if (cursor) errors++;
      } catch {
        // One inaccessible AWS scope must not stop sweeping the other scopes.
        errors++;
        yield;
      }
    }
    this.lastScan = { completed_at: new Date(this.now()).toISOString(), errors, expired, resources };
  }

  private isOrphan(resource: ResourceObservation, owner: string, scope: string): boolean {
    if (resource.tags[OWNER_TAG] !== owner) return false;
    const job = this.journal.get(resource.tags[OPERATION_TAG] ?? '');
    if (job && (job.release === 'pending' || job.release === 'requested')) {
      // ECS does not let us combine the startedBy filter with STOPPED. Pick up
      // those receipts here using both the original token and the saved tags.
      const stoppedFargate = job.target.kind === 'fargate' && resource.terminal && resource.launchToken === job.launchToken;
      const matchesResource = job.resourceId === resource.id || (job.resourceId === null && stoppedFargate);
      if (inventoryScope(job.target) === scope && matchesResource && matchesJobTags(resource.tags, job, owner)) {
        this.journal.observed(job.id, resource, this.now());
      }
      return false;
    }
    return !resource.terminal && isExpiredOwnedResource(resource.tags, owner, this.now());
  }
}
