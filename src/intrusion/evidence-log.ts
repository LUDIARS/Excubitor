import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { AccessEvidence } from './detection.js';

/** Vg file-format §2.2; metadata is whitelisted, never copied from raw headers. */
export function accessEvidenceWriter(root: string): (event: AccessEvidence, status: number) => void {
  const dir = join(root, 'excubitor-intrusion');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return (event, status) => {
    const day = new Date(event.at).toISOString().slice(0, 10);
    const ctx = { evt: 'security_access', service: event.service, hostname: event.hostname,
      country: /^(?:[A-Z]{2}|T1)$/.test(event.country) ? event.country : 'unknown',
      method: event.method.slice(0, 16), status,
      // Per-day correlation without retaining the literal IP or a sensitive URL.
      client_hash: createHash('sha256').update(day + ':' + event.clientIp).digest('hex'),
    };
    appendFileSync(join(dir, day + '.jsonl'), JSON.stringify({ ts: event.at, level: 'info',
      service: 'excubitor-intrusion', channel: 'app', msg: 'public ingress access', ctx }) + '\n',
    { encoding: 'utf8', mode: 0o600 });
  };
}
