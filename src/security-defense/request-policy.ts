import type { AccessEvidence } from '../intrusion/detection.js';
import type { AccessDecision } from '../intrusion/decision.js';
import type { DefenseConfig } from './config.js';

interface Window { start: number; requests: number; failures: number; missing: number; until: number }
const MAX_KEYS = 10000;

/** Service/client-scoped heuristic windows. No account identity inferred from HTTP success. */
export class RequestPolicy {
  private readonly windows = new Map<string, Window>();
  constructor(private readonly config: DefenseConfig, private readonly overrides?: ReadonlySet<string>) {}
  handles(service: string): boolean { return this.overrides?.has(service) ?? this.config.services.some(s => s.service === service); }
  inspect(event: AccessEvidence): AccessDecision | null {
    const rule = this.config.services.find(s => s.service === event.service);
    if (!rule) return null;
    const w = this.window(event);
    if (!w) return { source: 'gateway', action: 'observe', reason: 'capacity_exceeded' };
    if (w.until > event.at) return { source: 'gateway', action: 'deny', reason: 'temporary_limit' };
    w.requests++;
    return w.requests >= rule.requestsPerMinute ? this.flag(w, event, 'request_burst', 'gateway') : null;
  }
  response(event: AccessEvidence, status: number): AccessDecision | null {
    const rule = this.config.services.find(s => s.service === event.service);
    if (!rule) return null;
    const w = this.window(event);
    if (!w) return { source: 'upstream', action: 'observe', reason: 'capacity_exceeded' };
    if (status === 404 && ++w.missing >= rule.notFoundPerMinute) return this.flag(w, event, 'not_found_burst', 'upstream');
    if (rule.authPaths.includes(event.path) && (status === 401 || status === 403) && ++w.failures >= rule.authFailuresPerMinute) {
      return this.flag(w, event, 'authentication_burst', 'upstream');
    }
    return null;
  }
  private flag(w: Window, event: AccessEvidence, reason: AccessDecision['reason'], source: AccessDecision['source']): AccessDecision {
    if (this.config.mode === 'enforce' && w.until <= event.at) w.until = event.at + this.config.blockSeconds * 1000;
    return { source, reason, action: source === 'gateway' && this.config.mode === 'enforce' ? 'deny' : 'observe' };
  }
  private window(event: AccessEvidence): Window | null {
    const key = JSON.stringify([event.service, event.clientIp]);
    const old = this.windows.get(key);
    if (old && old.until > 0 && old.until <= event.at) {
      old.start = event.at; old.requests = 0; old.failures = 0; old.missing = 0; old.until = 0;
    }
    if (old && event.at >= old.start && event.at - old.start < 60000) return old;
    if (this.windows.size >= MAX_KEYS) {
      for (const [k, w] of this.windows) if (event.at - w.start >= 60000 && w.until <= event.at) this.windows.delete(k);
      if (!old && this.windows.size >= MAX_KEYS) return null;
    }
    const next = { start: event.at, requests: 0, failures: 0, missing: 0, until: old?.until ?? 0 };
    this.windows.set(key, next);
    return next;
  }
}
