import { IntrusionDetector, type AccessEvidence, type DetectionReason } from './detection.js';
import type { IntrusionConfig } from './config.js';

export interface RequestFilterDeps {
  evidence(event: AccessEvidence, status: number): void;
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

  constructor(config: IntrusionConfig, private readonly deps: RequestFilterDeps) {
    this.detector = new IntrusionDetector(config);
  }
  status(): { state: 'armed'; incident: null; logging: 'healthy' | 'failed' } {
    return { state: 'armed', incident: null, logging: this.loggingFailed ? 'failed' : 'healthy' };
  }
  start(): void { /* No global incident reconciler or background CF writes in this policy. */ }
  inspect(event: AccessEvidence): boolean {
    if (this.stopping) return false;
    const reason = this.detector.inspect(event);
    if (reason) {
      this.record(event, 403);
      this.report(event, reason);
      return false;
    }
    return true;
  }
  response(event: AccessEvidence, status: number): void {
    this.record(event, status);
    const reason = this.detector.response({ ...event, at: this.deps.now() }, status);
    if (reason) this.report(event, reason);
  }
  private record(event: AccessEvidence, status: number): void {
    try { this.deps.evidence(event, status); this.loggingFailed = false; }
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
