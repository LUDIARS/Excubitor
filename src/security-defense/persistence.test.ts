import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { DefenseStore } from './store.js';
import { Baseline } from './baseline.js';
import { deliverDaily } from './daily-delivery.js';
import { jstDay, reportDay } from './dates.js';
import { parseSshMessage } from './native-observation.js';

describe('durable defense evidence', () => {
  it('retains uncertain delivery across restart and never resends it automatically', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ex-defense-'));
    let store = new DefenseStore(join(dir, 'state.sqlite'));
    try {
      const send = vi.fn().mockRejectedValue(new Error('timeout after server accepted'));
      expect(await deliverDaily(store, '2026-11-04', 'headquarters', 1, send)).toBe('unknown');
      store.close(); store = new DefenseStore(join(dir, 'state.sqlite'));
      expect(await deliverDaily(store, '2026-11-04', 'headquarters', 2, send)).toBe('already_attempted');
      expect(send).toHaveBeenCalledTimes(1);
      expect(store.reports()[0]?.delivery).toBe('attempted_unknown');
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('requires exact complete candidate approval and detects later changes without reapproving', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ex-baseline-'));
    const store = new DefenseStore(join(dir, 'state.sqlite'));
    try {
      const baseline = new Baseline(store);
      baseline.observe([{ asset: 'app', hash: 'original' }], false, 1000);
      expect(baseline.approve(baseline.status().candidate!.digest, 'reviewed', 2000)).toBe(false);
      baseline.observe([{ asset: 'app', hash: 'original' }], true, 2000);
      expect(baseline.approve('bad', 'reviewed', 2001)).toBe(false);
      expect(baseline.approve(baseline.status().candidate!.digest, 'reviewed', 2001)).toBe(true);
      baseline.observe([{ asset: 'app', hash: 'changed' }, { asset: 'key', hash: 'new' }], true, 3000);
      baseline.observe([], false, 4000);
      const rules = store.data(jstDay(4000)).findings.map(f => f.rule);
      expect(rules).toContain('environment_changed');
      expect(rules).toContain('environment_added');
      expect(rules).not.toContain('environment_removed');
      baseline.observe([], true, 5000);
      expect(store.data(jstDay(5000)).findings.map(f => f.rule)).toContain('environment_removed');
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('uses JST midnight and 09:00 rather than host timezone', () => {
    expect(jstDay(Date.parse('2026-11-04T15:00:00Z'))).toBe('2026-11-05');
    expect(reportDay(Date.parse('2026-11-04T23:59:59Z'), 9)).toBeNull();
    expect(reportDay(Date.parse('2026-11-05T00:00:00Z'), 9)).toBe('2026-11-04');
  });
  it('parses actual SSH authentication with a pseudonymous actor', () => {
    const signal = parseSshMessage('Accepted publickey for alice from 203.0.113.5 port 12345 ssh2', 1000);
    expect(signal?.kind).toBe('ssh_success');
    expect(JSON.stringify(signal)).not.toContain('alice');
    expect(JSON.stringify(signal)).not.toContain('203.0.113.5');
    expect(parseSshMessage('session opened for user root', 1000)).toBeNull();
  });
});
