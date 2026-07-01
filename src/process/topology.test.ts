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

/** Catalog リテラルに memory_monitor 既定を補って組む。 */
function cat(services: Service[]): Catalog {
  return {
    services,
    memory_monitor: {
      enabled: true,
      interval_sec: 60,
      retention_hours: 48,
      default_service_rss_budget_mb: 1024,
      default_service_cpu_budget_pct: 80,
      wsl: { enabled: true, distros: [], leak_window_min: 120, leak_threshold_mb_per_hr: 200 },
      cpu_alert: { enabled: true, threshold_pct: 85, window_min: 15, sustained_ratio: 0.8, min_samples: 8 },
    },
  };
}

describe('envKey', () => {
  it('uppercases and replaces non-alnum with _', () => {
    expect(envKey('cernere-backend-dev')).toBe('CERNERE_BACKEND_DEV');
    expect(envKey('memoria-server')).toBe('MEMORIA_SERVER');
  });
});

describe('buildTopologyEnv', () => {
  it('auto-derives <CODE>_URL / <CODE>_PORT for services with port', () => {
    const env = buildTopologyEnv(cat([svc({ code: 'memoria-server', port: 5180 })]));
    expect(env['MEMORIA_SERVER_PORT']).toBe('5180');
    expect(env['MEMORIA_SERVER_URL']).toBe('http://localhost:5180');
  });

  it('skips services without a port', () => {
    expect(buildTopologyEnv(cat([svc({ code: 'no-port' })]))).toEqual({});
  });

  it('renders explicit provides templates and overrides auto keys', () => {
    const env = buildTopologyEnv(
      cat([
        svc({
          code: 'cernere-backend-dev',
          port: 8080,
          provides: {
            CERNERE_URL: 'http://${host}:${port}',
            CERNERE_WS_URL: 'ws://${host}:${port}',
          },
        }),
      ]),
    );
    expect(env['CERNERE_URL']).toBe('http://localhost:8080');
    expect(env['CERNERE_WS_URL']).toBe('ws://localhost:8080');
    // auto キーも共存
    expect(env['CERNERE_BACKEND_DEV_URL']).toBe('http://localhost:8080');
  });
});
