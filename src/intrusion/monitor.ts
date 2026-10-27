import { randomUUID } from 'node:crypto';
import { IntrusionDetector, type AccessEvidence, type DetectionReason } from './detection.js';
import type { IntrusionConfig } from './config.js';
import type { Incident } from './store.js';

export interface MonitorDeps {
  load(): Incident | null;
  save(incident: Incident): void;
  evidence(event: AccessEvidence, status: number): void;
  contain(): Promise<void>;
  notify(incident: Incident): Promise<void>;
  closePublicConnections(): void;
  warn(message: string): void;
  now(): number;
}

/** Synchronous safety latch, asynchronous durable containment/reporting workflow. */
export class IntrusionMonitor {
  private readonly detector: IntrusionDetector;
  private incident: Incident | null;
  private work: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  constructor(private readonly config: IntrusionConfig, private readonly deps: MonitorDeps) {
    this.detector = new IntrusionDetector(config);
    this.incident = deps.load(); // Corrupt/unreadable state must prevent startup.
  }
  status(): { state: 'armed' | 'blocked'; incident: Incident | null } {
    return { state: this.incident ? 'blocked' : 'armed', incident: this.incident ? { ...this.incident } : null };
  }
  start(): void {
    this.timer = setInterval(() => this.schedule(), 30_000);
    this.timer.unref();
    this.schedule();
  }
  inspect(event: AccessEvidence): boolean {
    if (this.stopping || this.incident) return false;
    const reason = this.detector.inspect(event);
    if (reason) {
      try { this.deps.evidence(event, 403); }
      catch { this.deps.warn('trigger evidence write failed; incident latch still required'); }
      this.trip(event, reason);
    }
    return !this.incident;
  }
  response(event: AccessEvidence, status: number): void {
    // No growing blocked-request log or report storm after the first incident.
    if (this.incident) return;
    try { this.deps.evidence(event, status); }
    catch { this.trip(event, 'evidence_failure'); return; }
    const reason = this.detector.response({ ...event, at: this.deps.now() }, status);
    if (reason) this.trip(event, reason);
  }
  trip(event: Pick<AccessEvidence, 'service' | 'at'>, reason: DetectionReason | 'unclean_restart'): void {
    if (this.incident) return;
    this.incident = { id: randomUUID(), site: this.config.site, service: event.service,
      at: event.at, reason, containment: 'pending', notification: 'pending',
      notifiedContainment: null, persistenceFailed: false };
    this.persist();
    this.deps.closePublicConnections();
    this.schedule();
  }
  private persist(): void {
    if (!this.incident) return;
    try {
      this.deps.save({ ...this.incident, persistenceFailed: false });
      this.incident.persistenceFailed = false;
    } catch {
      this.incident.persistenceFailed = true;
      this.deps.warn('incident persistence failed; ingress stays blocked');
    }
  }
  private schedule(): void {
    if (this.work || this.stopping || !this.incident) return;
    this.work = this.reconcile().catch(() => {
      this.deps.warn('incident reconciliation failed; ingress stays blocked');
    }).finally(() => { this.work = null; });
  }
  private async notify(): Promise<void> {
    const incident = this.incident;
    if (!incident || (incident.notification === 'sent' && incident.notifiedContainment === incident.containment)) return;
    try {
      await this.deps.notify({ ...incident });
      incident.notification = 'sent';
      incident.notifiedContainment = incident.containment;
    } catch {
      incident.notification = 'pending';
      this.deps.warn('security Discord delivery failed; retry retained');
    }
    this.persist();
  }
  private async reconcile(): Promise<void> {
    const incident = this.incident;
    if (!incident) return;
    this.persist();
    // Report the immediate local cutoff even if remote CF operations fail.
    await this.notify();
    if (incident.containment !== 'confirmed') {
      try { await this.deps.contain(); incident.containment = 'confirmed'; }
      catch { incident.containment = 'failed'; }
      this.persist();
    }
    await this.notify();
  }
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.work;
  }
}
