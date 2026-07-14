import { describe, expect, it } from 'vitest';
import type { Service } from '../catalog/loader.js';
import { getServiceByCode, setCatalogServices } from './service-registry.js';

function service(code: string): Service {
  return {
    code,
    name: code,
    runtime: 'node',
    disabled: false,
    monitor_only: false,
    autostart: false,
    restart_policy: 'no',
    max_restart: 5,
    required_env: [],
  } as unknown as Service;
}

describe('service-registry', () => {
  it('looks up a service by catalog code after setCatalogServices', () => {
    setCatalogServices([service('cernere'), service('aedilis')]);
    expect(getServiceByCode('cernere')?.code).toBe('cernere');
    expect(getServiceByCode('aedilis')?.code).toBe('aedilis');
  });

  it('returns undefined for an unknown code', () => {
    setCatalogServices([service('cernere')]);
    expect(getServiceByCode('does-not-exist')).toBeUndefined();
  });

  it('replaces the registry on subsequent calls (stays in sync with catalog reload)', () => {
    setCatalogServices([service('cernere')]);
    setCatalogServices([service('aedilis')]);
    expect(getServiceByCode('cernere')).toBeUndefined();
    expect(getServiceByCode('aedilis')?.code).toBe('aedilis');
  });
});
