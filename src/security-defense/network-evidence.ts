import { isIP } from 'node:net';
import type { AssessedDestination } from '../netwatch/types.js';

export interface NetworkEvidence {
  ip: string; country: string | null; ports: number[]; domains: string[];
  owners: { pid: number; name: string | null; service: string | null }[];
  reasons: string[]; firstSeenAt: number; lastSeenAt: number;
}
export interface NetworkEvidenceRow extends NetworkEvidence { firstAt: number; lastAt: number; count: number }

const label = (value: string): string => value.replace(/[\x00-\x1f\x7f@`<>]/g, '_').slice(0, 253);
/** Persist bounded attribution snapshots, never payloads, command lines or credentials. */
export function networkEvidence(destination: AssessedDestination): NetworkEvidence | null {
  if (!isIP(destination.remote) || !destination.assessment.reasons.length) return null;
  return {
    ip: destination.remote.toLowerCase(), country: destination.country,
    ports: [...new Set(destination.ports)].slice(0, 8).sort((a, b) => a - b),
    domains: [...new Set(destination.domains.map(label))].slice(0, 16).sort(),
    owners: destination.owners.slice(0, 8).map(o => ({ pid: o.pid,
      name: o.name === null ? null : label(o.name), service: o.service === null ? null : label(o.service) }))
      .sort((a, b) => a.pid - b.pid),
    reasons: [...new Set(destination.assessment.reasons)].sort(),
    firstSeenAt: destination.firstSeenMs, lastSeenAt: destination.lastSeenMs,
  };
}

export function networkEvidenceSummary(row: NetworkEvidenceRow): string {
  const owners = row.owners.map(o => `${o.name ?? '不明'}(PID ${o.pid})`).join(', ') || '不明';
  const text = `${row.ip} / ${new Date(row.lastAt).toISOString()} / port ${row.ports.join(',')} / ${row.reasons.join(',')} / process ${owners} / domain ${row.domains.join(',') || '未観測'}`;
  return text.length <= 300 ? text : text.slice(0, 285) + '…（詳細はAPI）';
}
