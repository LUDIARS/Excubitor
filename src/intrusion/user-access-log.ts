import { createHash } from 'node:crypto';
import type { AccessEvidence } from './detection.js';
import type { UserAccessMetadata } from './user-access-metadata.js';

export interface UserAccessEntry {
  ts: number; level: 'info'; service: string; channel: 'app'; msg: string;
  ctx: UserAccessMetadata & { evt: 'user_access'; service: string; hostname: string;
    country: string; client_hash: string; visitor_hash: string; identity_basis: 'ip_user_agent_language' };
}
const IDLE_MS = 30 * 60_000;
const MAX_VISITORS = 10_000;

/** First observation per service and inferred visitor; bounded sliding inactivity window.
 * @spec spec/feature/user-access-log.md#deduplication
 */
export class UserAccessLog {
  private readonly visits = new Map<string, number>();
  private failed = false;
  constructor(private readonly write: (entry: UserAccessEntry) => void,
    private readonly warn: (message: string) => void) {}

  status(): 'healthy' | 'failed' { return this.failed ? 'failed' : 'healthy'; }

  record(event: AccessEvidence, metadata: UserAccessMetadata): void {
    const day = new Date(event.at).toISOString().slice(0, 10);
    const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
    const visitor = hash(JSON.stringify([day, event.clientIp, metadata.user_agent, metadata.accept_language]));
    const key = JSON.stringify([event.service, visitor]);
    const previous = this.visits.get(key);
    if (previous !== undefined && event.at >= previous && event.at - previous < IDLE_MS) {
      this.visits.delete(key); this.visits.set(key, event.at);
      return;
    }
    try {
      this.write({ ts: event.at, level: 'info', service: `excubitor-user-access-${event.service}`,
        channel: 'app', msg: 'first user access in visit', ctx: {
          evt: 'user_access', service: event.service, hostname: event.hostname,
          country: /^(?:[A-Z]{2}|T1)$/.test(event.country) ? event.country : 'unknown',
          client_hash: hash(day + ':' + event.clientIp), visitor_hash: visitor,
          identity_basis: 'ip_user_agent_language', ...metadata,
        } });
      this.failed = false;
    } catch {
      // Logging must not turn a JP request into a site outage. Do not suppress the retry.
      this.failed = true; this.warn('user access log write failed; next access will retry');
      return;
    }
    this.visits.delete(key); this.visits.set(key, event.at);
    if (this.visits.size > MAX_VISITORS) {
      const oldest = this.visits.keys().next().value;
      if (oldest !== undefined) this.visits.delete(oldest);
    }
  }
}
