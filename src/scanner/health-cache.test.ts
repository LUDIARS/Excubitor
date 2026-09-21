import { beforeEach, describe, expect, it } from 'vitest';
import { clearHealthCache, getHealthCache, publishHealthResults } from './health-cache.js';

beforeEach(() => {
  clearHealthCache();
});

describe('health cache', () => {
  it('is empty until the first pass completes', () => {
    expect(getHealthCache()).toMatchObject({ completedAt: null, services: new Map() });
  });

  it('replaces the whole snapshot with each pass', () => {
    publishHealthResults({
      startedAt: 1_000,
      completedAt: 1_250,
      intervalMs: 60_000,
      results: new Map([
        ['a', { ok: true, reason: 'http', detail: 'HTTP 200', reportedVersion: '1.0.0' }],
        ['b', { ok: false, reason: 'failed' }],
      ]),
    });
    publishHealthResults({
      startedAt: 61_000,
      completedAt: 61_100,
      intervalMs: 60_000,
      results: new Map([['a', { ok: false, reason: 'tcp', detail: 'localhost:1' }]]),
    });

    const cache = getHealthCache();
    expect(cache).toMatchObject({ startedAt: 61_000, completedAt: 61_100, durationMs: 100, intervalMs: 60_000 });
    expect([...cache.services.keys()]).toEqual(['a']);
    expect(cache.services.get('a')).toEqual({
      ok: false, reason: 'tcp', detail: 'localhost:1', reportedVersion: null, checkedAt: 61_100,
    });
  });
});
