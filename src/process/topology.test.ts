import { describe, it, expect } from 'vitest';
import { buildTopologyEnv, envKey, parseTopologyHosts } from './topology.js';
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
    project_versions: {},
    docker: {},
    services,
    memory_monitor: {
      enabled: true,
      interval_sec: 60,
      retention_hours: 48,
      default_service_rss_budget_mb: 1024,
      default_service_cpu_budget_pct: 80,
      wsl: { enabled: true, distros: [], leak_window_min: 120, leak_threshold_mb_per_hr: 200 },
      cpu_alert: { enabled: true, threshold_pct: 85, window_min: 15, sustained_ratio: 0.8, min_samples: 8 },
      resource_alert: {
        enabled: true, disk_paths: [], disk_free_warn_pct: 10, disk_free_critical_pct: 5,
        memory_warn_pct: 90, memory_critical_pct: 97, memory_window_min: 10,
      },
    },
    retention: { enabled: true, logs_hours: 72, liveness_hours: 168, parquet_days: 90, interval_min: 60, batch_rows: 50_000 },
    log_store: { ring_lines_per_service: 2_000, ring_lines_global: 20_000, compact_hour_utc: 18 },
    monitor: { health_interval_sec: 60, inventory_interval_sec: 300, probe_concurrency: 8, liveness_heartbeat_sec: 300 },
    federation: { peer_poll_sec: 60, peer_timeout_ms: 5_000, stale_after_sec: 180, peer_down_after_sec: 300 },
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

  it('uses a per-site host override for a service hosted on another site', () => {
    const catalog = cat([
      svc({ code: 'cernere', port: 8080, provides: { CERNERE_BASE_URL: 'http://${host}:${port}', CERNERE_WS_URL: 'ws://${host}:${port}' } }),
      svc({ code: 'aedilis', port: 17502 }),
    ]);
    const env = buildTopologyEnv(catalog, parseTopologyHosts('cernere=100.84.227.24'));
    expect(env['CERNERE_BASE_URL']).toBe('http://100.84.227.24:8080');
    expect(env['CERNERE_WS_URL']).toBe('ws://100.84.227.24:8080');
    expect(env['CERNERE_URL']).toBe('http://100.84.227.24:8080');
    expect(env['AEDILIS_URL']).toBe('http://localhost:17502');
  });
});

describe('parseTopologyHosts', () => {
  it('parses code=host pairs and ignores blanks', () => {
    expect(parseTopologyHosts(undefined)).toEqual({});
    expect(parseTopologyHosts(' cernere = 100.84.227.24 , ,actio=macat.local')).toEqual({ cernere: '100.84.227.24', actio: 'macat.local' });
  });

  it('rejects malformed items so the operator notices', () => {
    for (const raw of ['cernere', 'cernere=', '=host', 'cernere=a=b', 'cernere=http://x', 'cernere=a b']) {
      expect(() => parseTopologyHosts(raw)).toThrow('EXCUBITOR_TOPOLOGY_HOSTS');
    }
  });
});
