import { IntrusionDetector, type AccessEvidence, type DetectionReason } from './detection.js';
import type { IntrusionConfig } from './config.js';
import type { AccessDecision } from './decision.js';
import type { RequestPolicy } from '../security-defense/request-policy.js';

export interface RequestFilterDeps {
  evidence(event: AccessEvidence, status: number, decision?: AccessDecision): void;
  policy?: RequestPolicy;
  notifyDenied(event: AccessEvidence, reason: DetectionReason): Promise<void>;
  warn(message: string): void;
  now(): number;
}

/** Reject a suspicious request without latching unrelated visitors or changing CF routes. */
export class RequestFilter {
  readonly rejectionStatus = 403;
  private readonly detector: IntrusionDetector;
  private stopping = false;
  private loggingFailed = false;
  private notification: Promise<void> | null = null;
  private nextNotification = -Infinity;
  private readonly observations = new WeakMap<AccessEvidence, AccessDecision>();

  constructor(config: IntrusionConfig, private readonly deps: RequestFilterDeps) {
    this.detector = new IntrusionDetector(config);
  }
  status(): { state: 'armed'; incident: null; logging: 'healthy' | 'failed' } {
    return { state: 'armed', incident: null, logging: this.loggingFailed ? 'failed' : 'healthy' };
  }
  start(): void { /* No global incident reconciler or background CF writes in this policy. */ }
  inspect(event: AccessEvidence): boolean {
    if (this.stopping) return false;
    const reason = this.detector.inspect(event, this.deps.policy?.handles(event.service) ?? false);
    if (reason) {
      this.record(event, 403, { source: 'gateway', action: 'deny', reason });
      this.report(event, reason);
      return false;
    }
    const decision = this.deps.policy?.inspect(event);
    if (decision?.action === 'deny') { this.record(event, 403, decision); return false; }
    if (decision) this.observations.set(event, decision);
    return true;
  }
  response(event: AccessEvidence, status: number): void {
    const reason = this.deps.policy?.handles(event.service) ? null : this.detector.response({ ...event, at: this.deps.now() }, status);
    const decision = this.deps.policy?.response(event, status) ?? this.observations.get(event);
    this.observations.delete(event);
    this.record(event, status, decision ?? { source: 'upstream', action: reason ? 'observe' : 'allow', reason: reason ?? 'none' });
    if (reason) this.report(event, reason);
  }
  private record(event: AccessEvidence, status: number, decision: AccessDecision): void {
    try { this.deps.evidence(event, status, decision); this.loggingFailed = false; }
    catch {
      // Keep JP availability; explicitly expose degraded logging rather than close every route.
      this.loggingFailed = true;
      this.deps.warn('request-filter access evidence write failed');
    }
  }
  private report(event: AccessEvidence, reason: DetectionReason): void {
    if (this.notification || this.deps.now() < this.nextNotification) return;
    this.nextNotification = this.deps.now() + 60_000;
    this.notification = Promise.resolve().then(() => this.deps.notifyDenied(event, reason))
      .catch(() => this.deps.warn('request-filter Discord report failed; later events may retry'))
      .finally(() => { this.notification = null; });
  }
  async stop(): Promise<void> { this.stopping = true; await this.notification; }
}
