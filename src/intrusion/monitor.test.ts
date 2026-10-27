import { describe, it, expect, vi } from 'vitest';
import { IntrusionMonitor, type MonitorDeps } from './monitor.js';
import { incidentMessage } from './discord.js';
import type { Incident } from './store.js';
import { config, event } from './test-fixtures.js';

function harness(overrides: Partial<MonitorDeps> = {}): { monitor: IntrusionMonitor; deps: MonitorDeps; saved: () => Incident | null } {
  let saved: Incident | null = null;
  const deps: MonitorDeps = { load: () => saved, save: value => { saved = structuredClone(value); },
    evidence: vi.fn(), contain: vi.fn().mockResolvedValue(undefined), notify: vi.fn().mockResolvedValue(undefined),
    closePublicConnections: vi.fn(), warn: vi.fn(), now: () => 1000, ...overrides };
  return { monitor: new IntrusionMonitor(config, deps), deps, saved: () => saved };
}

describe('incident lifecycle', () => {
  it('latches synchronously and deduplicates concurrent triggers before remote operations finish', async () => {
    let release: (() => void) | undefined;
    const h = harness({ contain: () => new Promise<void>(resolve => { release = resolve; }) });
    expect(h.monitor.inspect({ ...event, country: 'US' })).toBe(false);
    expect(h.saved()?.reason).toBe('foreign_country');
    expect(h.monitor.inspect(event)).toBe(false);
    expect(h.deps.closePublicConnections).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(release).toBeDefined());
    release?.();
    await h.monitor.stop();
    expect(h.saved()?.containment).toBe('confirmed');
  });
  it('restores a persisted latch and never auto-reopens after a containment/Discord failure', async () => {
    const first = harness();
    first.monitor.inspect({ ...event, country: 'US' });
    await first.monitor.stop();
    const snapshot = first.saved();
    if (!snapshot) throw new Error('expected snapshot');
    const next = harness({ load: () => ({ ...snapshot, containment: 'pending', notification: 'pending' }),
      contain: vi.fn().mockRejectedValue(new Error('CF unavailable')),
      notify: vi.fn().mockRejectedValue(new Error('Discord unavailable')) });
    next.monitor.start();
    await next.monitor.stop();
    expect(next.monitor.inspect(event)).toBe(false);
    expect(next.saved()).toMatchObject({ containment: 'failed', notification: 'pending' });
  });
  it('closes connections even when incident persistence fails', async () => {
    const h = harness({ save: () => { throw new Error('disk unavailable'); } });
    h.monitor.inspect({ ...event, country: 'US' });
    expect(h.monitor.status().incident?.persistenceFailed).toBe(true);
    expect(h.deps.closePublicConnections).toHaveBeenCalledOnce();
    await h.monitor.stop();
  });
  it('does not put client address, URL, headers or query secrets in reports', async () => {
    const h = harness();
    h.monitor.inspect({ ...event, country: 'US', path: '/?secret=DO_NOT_REPORT' });
    await h.monitor.stop();
    const incident = h.saved();
    if (!incident) throw new Error('expected incident');
    const text = incidentMessage(incident);
    expect(text).not.toContain(event.clientIp);
    expect(text).not.toContain('DO_NOT_REPORT');
  });
});
