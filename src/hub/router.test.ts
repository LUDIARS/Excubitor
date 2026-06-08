import { describe, it, expect } from 'vitest';
import { excubitorManifest, summarizeServices } from './router.js';

describe('summarizeServices', () => {
  it('counts running as up, unknown/null as unknown, others as down', () => {
    const rows = [
      { state: 'running' },
      { state: 'running' },
      { state: 'stopped' },
      { state: 'exited' },
      { state: 'unknown' },
      { state: null },
      {}, // state 欠落も unknown
    ];
    const s = summarizeServices(rows, 3);
    expect(s).toEqual({
      service: 'excubitor',
      services_total: 7,
      up: 2,
      down: 2,
      unknown: 3,
      open_errors: 3,
    });
  });

  it('handles empty service list', () => {
    expect(summarizeServices([], 0)).toEqual({
      service: 'excubitor',
      services_total: 0,
      up: 0,
      down: 0,
      unknown: 0,
      open_errors: 0,
    });
  });
});

describe('excubitorManifest', () => {
  it('declares corpusApi=1, health, and hub data endpoints', () => {
    const m = excubitorManifest('0.2.0');
    expect(m.service).toBe('excubitor');
    expect(m.corpusApi).toBe(1);
    expect(m.version).toBe('0.2.0');
    expect(m.health).toBe('/api/hub/health');
    expect(m.auth).toBe('none');
    const data = m.data as Array<{ id: string; path: string; scope: string }>;
    expect(data.map((d) => d.id)).toEqual(['summary', 'services', 'apps', 'errors']);
    expect(data.every((d) => d.scope === 'multi')).toBe(true);
    expect(data.find((d) => d.id === 'summary')?.path).toBe('/api/hub/summary');
    expect(data.find((d) => d.id === 'apps')?.path).toBe('/api/hub/apps');
  });

  it('exposes launch/stop actions for local apps', () => {
    const m = excubitorManifest('0.2.0');
    const actions = m.actions as Array<{ id: string; method: string; path: string; appliesTo: string }>;
    expect(actions.map((a) => a.id)).toEqual(['app-launch', 'app-stop']);
    expect(actions.every((a) => a.appliesTo === 'apps')).toBe(true);
    expect(actions.every((a) => a.path === '/api/v1/services/:code/control')).toBe(true);
  });
});
