import { isIP } from 'node:net';
import type { IntrusionConfig } from './config.js';

export interface AccessEvidence {
  service: string;
  hostname: string;
  clientIp: string;
  country: string;
  path: string;
  method: string;
  at: number;
}
export type DetectionReason = 'foreign_country' | 'unknown_country' | 'invalid_identity' |
  'exploit_path' | 'request_burst' | 'authentication_burst' | 'capacity_exceeded' | 'evidence_failure';
interface Counter { start: number; requests: number; failures: number }
const WINDOW_MS = 60_000;
const MAX_CLIENTS = 10_000;

/** Bounded deterministic indicators; no request data is interpreted as executable rules. */
export class IntrusionDetector {
  private readonly clients = new Map<string, Counter>();
  constructor(private readonly config: IntrusionConfig) {}

  inspect(event: AccessEvidence): DetectionReason | null {
    if (!isIP(event.clientIp)) return 'invalid_identity';
    if (!/^[A-Z]{2}$/.test(event.country) || event.country === 'XX') {
      return event.country === 'T1' ? 'foreign_country' : 'unknown_country';
    }
    if (!this.config.allowedCountries.includes(event.country)) return 'foreign_country';
    let path = event.path;
    try {
      path = decodeURIComponent(path);
      for (let i = 0; i < 2 && /%[0-9a-f]{2}/i.test(path); i++) path = decodeURIComponent(path);
    }
    catch { return 'exploit_path'; }
    if (/(?:^|[\\/])\.\.(?:[\\/]|$)|\x00|(?:^|\/)\.(?:env(?:\.|\/|$)|git(?:\/|$))|\/(?:etc\/passwd|proc\/self\/environ)(?:\/|$)/i.test(path)) {
      return 'exploit_path';
    }
    const count = this.counter(event);
    if (!count) return 'capacity_exceeded';
    count.requests++;
    return count.requests >= this.config.requestsPerMinute ? 'request_burst' : null;
  }

  response(event: AccessEvidence, status: number): DetectionReason | null {
    if (status !== 401 && status !== 403) return null;
    const count = this.counter(event);
    if (!count) return 'capacity_exceeded';
    count.failures++;
    return count.failures >= this.config.authFailuresPerMinute ? 'authentication_burst' : null;
  }

  private counter(event: AccessEvidence): Counter | null {
    let count = this.clients.get(event.clientIp);
    if (count && event.at - count.start < WINDOW_MS) return count;
    if (this.clients.size >= MAX_CLIENTS) {
      for (const [ip, value] of this.clients) if (event.at - value.start >= WINDOW_MS) this.clients.delete(ip);
      if (!count && this.clients.size >= MAX_CLIENTS) return null;
    }
    count = { start: event.at, requests: 0, failures: 0 };
    this.clients.set(event.clientIp, count);
    return count;
  }
}
