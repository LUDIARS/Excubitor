import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AssessedDestination } from '../netwatch/types.js';
import { networkEvidence } from './network-evidence.js';
import { DefenseStore } from './store.js';
import { dailyMessage } from './report.js';
import { jstDay } from './dates.js';

describe('inspectable network evidence', () => {
  it('retains IP and changed attribution after restart, groups by IP and expires old evidence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ex-network-evidence-'));
    const file = join(dir, 'evidence.sqlite');
    let store = new DefenseStore(file);
    const at = Date.parse('2026-11-06T01:00:00Z');
    const destination: AssessedDestination = { remote: '2001:db8::7', scope: 'public', country: null, locality: 'unknown',
      ports: [443], domains: [], kinds: ['syn'], firstSeenMs: at - 1000, lastSeenMs: at, packets: 2,
      owners: [{ pid: 123, name: 'first.exe', service: null }], assessment: { services: [], reasons: ['direct-ip', 'unusual-port'] } };
    try {
      const first = networkEvidence(destination)!;
      store.network(at, first);
      store.network(at + 1000, { ...first, lastSeenAt: at + 500 });
      store.network(at + 2000, { ...first, owners: [{ pid: 456, name: 'second.exe', service: null }] });
      store.close(); store = new DefenseStore(file);
      const data = store.data(jstDay(at));
      expect(data.network).toHaveLength(2);
      expect(data.network?.find(row => row.owners[0]?.pid === 123)).toMatchObject({ ip: '2001:db8::7', count: 2, lastSeenAt: at + 500 });
      const report = dailyMessage('headquarters', data);
      expect(report).toContain('通信先 1件');
      expect(report).toContain('2001:db8::7');
      expect(report).toContain('second.exe');
      expect(report.length).toBeLessThanOrEqual(1950);
      store.claimReport(jstDay(at), JSON.stringify(data));
      expect(JSON.parse(store.reports()[0]!.body).network[0].ip).toBe(destination.remote);
      store.prune(at + 92 * 86400000);
      expect(store.networkRows(jstDay(at))).toHaveLength(0);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('labels legacy hash-only records without pretending to recover their IP', () => {
    const report = dailyMessage('hq', { day: '2026-11-05', counts: [], coverage: [], metrics: [],
      findings: [{ rule: 'network_direct-ip', asset: 'f421a1654462:unknown:80', count: 1, firstAt: 1, lastAt: 1 }] });
    expect(report).toContain('詳細未保存の検知 1件');
    expect(report).not.toContain('f421a1654462');
  });
});
