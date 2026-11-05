import { createHash } from 'node:crypto';
import type { DefenseStore } from './store.js';

export interface Fingerprint { asset: string; hash: string; localPath?: string }
export interface BaselineCandidate { digest: string; complete: boolean; entries: Fingerprint[]; at: number }
export function fingerprint(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }

/** Only explicit approval advances trust; observations never overwrite the approved baseline. */
export class Baseline {
  private candidate: BaselineCandidate | null = null;
  constructor(private readonly store: DefenseStore) {}
  observe(entries: Fingerprint[], complete: boolean, at: number): void {
    entries.sort((a, b) => a.asset.localeCompare(b.asset));
    this.candidate = { entries, complete, at, digest: fingerprint(JSON.stringify(entries)) };
    const raw = this.store.state('baseline');
    if (!raw) { this.store.coverage(at, 'baseline', 'unapproved'); return; }
    const approved = JSON.parse(raw) as BaselineCandidate;
    const before = new Map(approved.entries.map(e => [e.asset, e.hash]));
    for (const entry of entries) {
      if (before.get(entry.asset) !== entry.hash) this.store.finding(at, before.has(entry.asset) ? 'environment_changed' : 'environment_added', entry.asset);
      before.delete(entry.asset);
    }
    // Incomplete scans must not misrepresent unreadable objects as removed.
    if (complete) for (const asset of before.keys()) this.store.finding(at, 'environment_removed', asset);
    this.store.coverage(at, 'baseline', complete ? 'healthy' : 'incomplete');
  }
  status(): { approved: boolean; candidate: Omit<BaselineCandidate, 'entries'> | null; entries: number } {
    const c = this.candidate;
    return { approved: this.store.state('baseline') !== null,
      candidate: c ? { digest: c.digest, complete: c.complete, at: c.at } : null, entries: c?.entries.length ?? 0 };
  }
  review(): BaselineCandidate | null { return this.candidate; }
  approve(digest: string, note: string, now: number): boolean {
    const c = this.candidate;
    if (!c?.complete || c.digest !== digest || now - c.at > 600000 || now < c.at) return false;
    this.store.setState('baseline', JSON.stringify(c));
    this.store.setState('baseline_approval', JSON.stringify({ digest, at: now, note }));
    this.store.finding(now, 'baseline_approved', digest);
    return true;
  }
}
