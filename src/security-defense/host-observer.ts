import type { Catalog } from '../catalog/loader.js';
import type { NetwatchSnapshot } from '../netwatch/runtime.js';
import { getFreshProcessSnapshot } from '../process-snapshot/store.js';
import { fingerprint, Baseline } from './baseline.js';
import { fileInventory } from './file-inventory.js';
import { nativeObservation, type AuthSignal } from './native-observation.js';
import type { DefenseStore } from './store.js';
import { networkEvidence } from './network-evidence.js';

/** Joins local collectors without taking control of processes, packet capture or firewall. */
export class HostObserver {
  private lastAt: number;
  private readonly failures = new Map<string, { count: number; at: number }>();
  constructor(private readonly store: DefenseStore, readonly baseline: Baseline, private readonly catalog: Catalog,
    private readonly paths: string[], private readonly network: (() => NetwatchSnapshot) | undefined, now: number) {
    this.lastAt = now - 300000;
    store.coverage(now, 'host_history', 'startup_gap');
  }
  async sample(now: number): Promise<void> {
    const [files, native] = await Promise.all([fileInventory(this.catalog, this.paths), nativeObservation(this.lastAt)]);
    if (native.state === 'healthy') this.lastAt = now;
    this.store.coverage(now, 'ssh', native.state);
    this.store.coverage(now, 'files', files.complete ? 'healthy' : 'incomplete');
    this.store.coverage(now, 'host_inventory', native.inventoryState);
    for (const signal of native.auth) if (signal.at <= now) this.auth(signal);
    this.baseline.observe([...files.entries, ...native.entries], files.complete && native.inventoryState === 'healthy', now);
    this.processes(now);
    this.netwatch(now);
    this.store.coverage(now, 'cf_edge', 'not_collected');
    this.store.coverage(now, 'other_hosts', 'not_collected');
  }
  private auth(signal: AuthSignal): void {
    this.store.finding(signal.at, signal.kind, signal.actor);
    const old = this.failures.get(signal.actor);
    if (signal.kind === 'ssh_success') {
      if (old && signal.at - old.at <= 600000 && old.count >= 5) this.store.finding(signal.at, 'ssh_success_after_failures', signal.actor);
      this.failures.delete(signal.actor);
    } else {
      for (const [key, value] of this.failures) if (signal.at - value.at > 600000) this.failures.delete(key);
      if (this.failures.size < 10000 || old) this.failures.set(signal.actor, { count: old && signal.at - old.at <= 600000 ? old.count + 1 : 1, at: signal.at });
      else this.store.coverage(signal.at, 'auth_correlation', 'capacity');
    }
  }
  private processes(now: number): void {
    const snapshot = getFreshProcessSnapshot(now);
    this.store.coverage(now, 'processes', snapshot ? 'healthy' : 'stale_or_missing');
    if (!snapshot) return;
    const names = [...new Set(snapshot.processes.map(p => (p.name ?? 'unknown').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 64)))].sort();
    const raw = this.store.state('process_names');
    if (raw) {
      const before = new Set(JSON.parse(raw) as string[]);
      for (const name of names) if (!before.has(name)) this.store.finding(now, 'new_process_name', name);
    } else this.store.coverage(now, 'process_history', 'first_observation');
    this.store.setState('process_names', JSON.stringify(names));
  }
  private netwatch(now: number): void {
    const snapshot = this.network?.();
    if (!snapshot) { this.store.coverage(now, 'tshark', 'unavailable'); return; }
    this.store.coverage(now, 'tshark', snapshot.status.state === 'running' ? 'healthy' : snapshot.status.state);
    this.store.coverage(now, 'network_process_attribution', snapshot.attribution.state === 'running' ? 'healthy' : snapshot.attribution.state);
    if (snapshot.status.state !== 'running') return;
    const raw = this.store.state('network_packets');
    if (!raw) this.store.coverage(now, 'tshark_history', 'first_observation');
    const before = new Map<string, number>(raw ? JSON.parse(raw) as [string, number][] : []);
    const next: [string, number][] = [];
    for (const destination of snapshot.destinations.slice(0, 10000)) {
      const key = fingerprint(destination.remote);
      const previous = before.get(key) ?? 0;
      const delta = !raw ? 0 : destination.packets >= previous ? destination.packets - previous : destination.packets;
      next.push([key, destination.packets]);
      if (!delta) continue;
      const evidence = networkEvidence(destination);
      if (evidence) this.store.network(now, evidence);
      const country = /^[A-Z]{2}$/.test(destination.country ?? '') ? destination.country : 'unknown';
      this.store.metric(now, `network_country_${country}`, delta);
      this.store.metric(now, 'network_observed_packets', delta);
      if (!destination.owners.length) this.store.metric(now, 'network_unattributed_packets', delta);
      for (const owner of destination.owners.slice(0, 8)) {
        const label = (owner.service ?? owner.name ?? 'unknown').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 64);
        this.store.metric(now, `network_owner_${label}`, delta);
      }
      for (const port of destination.ports.slice(0, 8)) this.store.metric(now, `network_port_${port}`, delta);
      for (const reason of destination.assessment.reasons) {
        this.store.finding(now, `network_${reason}`, destination.remote);
      }
    }
    if (snapshot.destinations.length > 10000) this.store.coverage(now, 'tshark', 'capacity');
    this.store.setState('network_packets', JSON.stringify(next));
  }
}
