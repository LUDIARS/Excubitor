import { describe, expect, it } from 'vitest';
import type { Catalog } from '../catalog/loader.js';
import { DEFAULT_HEALTH_INTERVAL_SEC, DEFAULT_INVENTORY_INTERVAL_SEC, monitorIntervals } from './loop.js';

describe('monitor intervals', () => {
  it('checks health every minute and takes inventory every five minutes by default', () => {
    expect(DEFAULT_HEALTH_INTERVAL_SEC).toBe(60);
    expect(DEFAULT_INVENTORY_INTERVAL_SEC).toBe(300);
    expect(monitorIntervals({} as Pick<Catalog, 'monitor'>)).toEqual({ healthMs: 60_000, inventoryMs: 300_000 });
  });

  it('follows the runtime config monitor block', () => {
    const catalog = {
      monitor: { health_interval_sec: 30, inventory_interval_sec: 900, probe_concurrency: 4, liveness_heartbeat_sec: 300 },
    } as Pick<Catalog, 'monitor'>;
    expect(monitorIntervals(catalog)).toEqual({ healthMs: 30_000, inventoryMs: 900_000 });
  });
});
