import { describe, it, expect } from 'vitest';
import { buildTopologyEnv, envKey } from './topology.js';
import type { Catalog, Service } from '../catalog/loader.js';

function svc(p: Partial<Service>): Service {
  return {
    code: 'x',
    name: 'X',
    monitor_only: false,
    runtime: 'node',
    autostart: false,
    restart_policy: 'no',
    max_restart: 5,
    ...p,
  } as Service;
}

describe('envKey', () => {
  it('uppercases and replaces non-alnum with _', () => {
    expect(envKey('cernere-backend-dev')).toBe('CERNERE_BACKEND_DEV');
    expect(envKey('memoria-server')).toBe('MEMORIA_SERVER');
  });
});

describe('buildTopologyEnv', () => {
  it('auto-derives <CODE>_URL / <CODE>_PORT for services with port', () => {
    const cat: Catalog = { services: [svc({ code: 'memoria-server', port: 5180 })] };
    const env = buildTopologyEnv(cat);
    expect(env['MEMORIA_SERVER_PORT']).toBe('5180');
    expect(env['MEMORIA_SERVER_URL']).toBe('http://localhost:5180');
  });

  it('skips services without a port', () => {
    const cat: Catalog = { services: [svc({ code: 'no-port' })] };
    expect(buildTopologyEnv(cat)).toEqual({});
  });

  it('renders explicit provides templates and overrides auto keys', () => {
    const cat: Catalog = {
      services: [
        svc({
          code: 'cernere-backend-dev',
          port: 8080,
          provides: {
            CERNERE_URL: 'http://${host}:${port}',
            CERNERE_WS_URL: 'ws://${host}:${port}',
          },
        }),
      ],
    };
    const env = buildTopologyEnv(cat);
    expect(env['CERNERE_URL']).toBe('http://localhost:8080');
    expect(env['CERNERE_WS_URL']).toBe('ws://localhost:8080');
    // auto キーも共存
    expect(env['CERNERE_BACKEND_DEV_URL']).toBe('http://localhost:8080');
  });
});
