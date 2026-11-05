import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import type { Catalog } from '../catalog/loader.js';
import type { NetwatchSnapshot } from '../netwatch/runtime.js';
import { HostObserver } from './host-observer.js';
import { DefenseStore } from './store.js';
import { Baseline } from './baseline.js';
import { jstDay } from './dates.js';
import { dailyMessage } from './report.js';

vi.mock('./file-inventory.js', () => ({ fileInventory: async () => ({ entries: [], complete: true, errors: 0 }) }));
vi.mock('./native-observation.js', () => ({ nativeObservation: async () => ({ state: 'failed', inventoryState: 'healthy', auth: [], entries: [] }) }));
vi.mock('../process-snapshot/store.js', () => ({ getFreshProcessSnapshot: () => null }));

describe('tshark report observation', () => {
  it('uses deltas, distinguishes missing collectors, and does not call foreign traffic an attack', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ex-network-report-'));
    const store = new DefenseStore(join(dir, 'state.sqlite'));
    const destination = { remote: '203.0.113.7', country: 'US', packets: 100, owners: [{ name: 'browser.exe', service: null, pid: 10 }], ports: [443], assessment: { services: [], reasons: [] } };
    const snapshot = { status: { state: 'running' }, attribution: { state: 'running' }, destinations: [destination] } as unknown as NetwatchSnapshot;
    const observer = new HostObserver(store, new Baseline(store), { services: [] } as unknown as Catalog, [], () => snapshot, 1000);
    try {
      await observer.sample(1000);
      destination.packets = 120;
      await observer.sample(2000);
      await observer.sample(3000);
      const data = store.data(jstDay(3000));
      expect(data.metrics.find(m => m.name === 'network_observed_packets')?.value).toBe(20);
      expect(data.findings.filter(f => f.rule.startsWith('network_'))).toHaveLength(0);
      expect(data.coverage).toContainEqual(expect.objectContaining({ source: 'ssh', state: 'failed' }));
      const report = dailyMessage('headquarters', data);
      expect(report).toContain('US=20');
      expect(report).toContain('browser.exe=20');
      expect(report).not.toContain(destination.remote);
      expect(report).toContain('侵入なしの証明ではありません');
      expect(report.length).toBeLessThanOrEqual(1950);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
