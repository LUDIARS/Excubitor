import { describe, expect, it } from 'vitest';
import {
  BACKEND_READINESS_TIMEOUT_ENV,
  DEFAULT_BACKEND_READINESS_TIMEOUT_MS,
  loadBackendReadinessTimeout,
  MAX_BACKEND_READINESS_TIMEOUT_MS,
  MIN_BACKEND_READINESS_TIMEOUT_MS,
  resolveBackendReadinessTimeout,
} from './backend-readiness-timeout.js';
import timeoutContract from './backend-readiness-timeout.contract.js';

describe('resolveBackendReadinessTimeout', () => {
  it('defaults to 90000ms when neither env nor config store is set', () => {
    expect(resolveBackendReadinessTimeout({ env: undefined, configured: null })).toEqual({
      value: 90_000,
      source: 'default',
      ignored: [],
    });
    expect(DEFAULT_BACKEND_READINESS_TIMEOUT_MS).toBe(90_000);
  });

  it('treats a blank env value as unset', () => {
    expect(resolveBackendReadinessTimeout({ env: '   ', configured: undefined })).toMatchObject({
      value: 90_000,
      source: 'default',
      ignored: [],
    });
  });

  it('prefers env over the config store', () => {
    expect(resolveBackendReadinessTimeout({ env: ' 120000 ', configured: 45_000 })).toMatchObject({
      value: 120_000,
      source: 'env',
      ignored: [],
    });
  });

  it('uses the config store when env is unset', () => {
    expect(resolveBackendReadinessTimeout({ env: undefined, configured: 45_000 })).toMatchObject({
      value: 45_000,
      source: 'config',
      ignored: [],
    });
  });

  it('accepts both inclusive range boundaries', () => {
    expect(resolveBackendReadinessTimeout({ env: String(MIN_BACKEND_READINESS_TIMEOUT_MS), configured: null }).value)
      .toBe(10_000);
    expect(resolveBackendReadinessTimeout({ env: String(MAX_BACKEND_READINESS_TIMEOUT_MS), configured: null }).value)
      .toBe(600_000);
  });

  it('ignores out-of-range env values instead of clamping them', () => {
    for (const env of ['9999', '600001', '0']) {
      const resolution = resolveBackendReadinessTimeout({ env, configured: null });
      expect(resolution).toMatchObject({ value: 90_000, source: 'default' });
      expect(resolution.ignored).toEqual([{ source: 'env', detail: expect.stringContaining('10000..600000') }]);
    }
  });

  it('ignores non-integer env values', () => {
    for (const env of ['90s', '1.5e5', '-20000', '15000.5', 'abc']) {
      const resolution = resolveBackendReadinessTimeout({ env, configured: null });
      expect(resolution).toMatchObject({ value: 90_000, source: 'default' });
      expect(resolution.ignored).toHaveLength(1);
    }
  });

  it('falls through an invalid env value to a valid config store value', () => {
    expect(resolveBackendReadinessTimeout({ env: '5000', configured: 60_000 })).toMatchObject({
      value: 60_000,
      source: 'config',
      ignored: [{ source: 'env' }],
    });
  });

  it('ignores invalid config store values and reports both sources', () => {
    const resolution = resolveBackendReadinessTimeout({ env: 'x', configured: 700_000 });
    expect(resolution).toMatchObject({ value: 90_000, source: 'default' });
    expect(resolution.ignored.map((entry) => entry.source)).toEqual(['env', 'config']);
    expect(resolveBackendReadinessTimeout({ env: undefined, configured: 12_000.5 }).source).toBe('default');
    expect(resolveBackendReadinessTimeout({ env: undefined, configured: true }).source).toBe('default');
  });
});

describe('loadBackendReadinessTimeout', () => {
  it('reads the env variable and the config store', () => {
    expect(loadBackendReadinessTimeout({ [BACKEND_READINESS_TIMEOUT_ENV]: '30000' }, () => 45_000)).toMatchObject({
      value: 30_000,
      source: 'env',
    });
    expect(loadBackendReadinessTimeout({}, () => 45_000)).toMatchObject({ value: 45_000, source: 'config' });
    expect(loadBackendReadinessTimeout({}, () => null)).toMatchObject({ value: 90_000, source: 'default' });
  });

  it('treats an unreadable config store as unset instead of failing the backend start', () => {
    const resolution = loadBackendReadinessTimeout({}, () => {
      throw new Error('EPERM');
    });
    expect(resolution).toMatchObject({ value: 90_000, source: 'default' });
    expect(resolution.ignored).toEqual([{ source: 'config', detail: 'config store unreadable: EPERM' }]);
  });
});

describe('C-10 resolveBackendReadinessTimeout contract', () => {
  it('holds for every resolution shape the implementation returns', () => {
    const inputs = [
      { env: undefined, configured: null },
      { env: '120000', configured: null },
      { env: undefined, configured: 45_000 },
      { env: '1', configured: 9_000_000 },
      { env: 'NaN', configured: 'x' },
    ];
    for (const input of inputs) {
      expect(timeoutContract.post(resolveBackendReadinessTimeout(input))).toBe(true);
    }
  });

  it('rejects out-of-range values and a non-default default', () => {
    expect(timeoutContract.post({ value: 9_999, source: 'env', ignored: [] })).toEqual(expect.any(String));
    expect(timeoutContract.post({ value: 30_000, source: 'default', ignored: [] })).toEqual(expect.any(String));
    expect(timeoutContract.post({ value: 30_000, source: 'cli', ignored: [] })).toEqual(expect.any(String));
  });
});
