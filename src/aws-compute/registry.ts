import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { computeTargetSchema, type ComputeTarget } from './target-schema.js';

type TargetRow = { config: string };
const MAX_TARGETS = 24;

function readTarget(row: TargetRow): ComputeTarget {
  return computeTargetSchema.parse(JSON.parse(row.config));
}

export class ComputeRegistry {
  constructor(private readonly db: Database.Database) {}

  owner(): string {
    const read = this.db.prepare('SELECT owner FROM aws_compute_identity WHERE id = 1');
    const existing = read.get() as { owner: string } | undefined;
    if (existing) return existing.owner;
    this.db.prepare('INSERT OR IGNORE INTO aws_compute_identity(id, owner) VALUES (1, ?)').run(`excubitor-${randomUUID()}`);
    return (read.get() as { owner: string }).owner;
  }

  list(): ComputeTarget[] {
    return (this.db.prepare('SELECT config FROM aws_compute_targets ORDER BY id').all() as TargetRow[]).map(readTarget);
  }

  get(id: string): ComputeTarget | null {
    const row = this.db.prepare('SELECT config FROM aws_compute_targets WHERE id = ?').get(id) as TargetRow | undefined;
    return row ? readTarget(row) : null;
  }

  put(target: ComputeTarget): 'saved' | 'target_busy' | 'target_limit' {
    return this.db.transaction(() => {
      if (this.busy(target.id)) return 'target_busy';
      if (!this.get(target.id) && this.count() >= MAX_TARGETS) return 'target_limit';
      this.db.prepare(`INSERT INTO aws_compute_targets(id, config) VALUES (?, ?)
        ON CONFLICT(id) DO UPDATE SET config = excluded.config`).run(target.id, JSON.stringify(target));
      return 'saved';
    }).immediate();
  }

  delete(id: string): 'deleted' | 'target_busy' | 'target_not_found' {
    return this.db.transaction(() => {
      if (this.busy(id)) return 'target_busy';
      const { changes } = this.db.prepare('DELETE FROM aws_compute_targets WHERE id = ?').run(id);
      return changes ? 'deleted' : 'target_not_found';
    }).immediate();
  }

  private count(): number {
    return (this.db.prepare('SELECT count(*) AS count FROM aws_compute_targets').get() as { count: number }).count;
  }

  private busy(id: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM aws_compute_jobs WHERE target_id = ? AND release IN ('pending', 'requested')`).get(id));
  }
}
