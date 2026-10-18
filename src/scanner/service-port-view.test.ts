import { describe, expect, it } from 'vitest';
import { servicePortView } from './service-port-view.js';

describe('service port provenance', () => {
  it('uses current catalog while preserving an old process observation', () => {
    expect(servicePortView({ catalog_snapshot: JSON.stringify({ port: 17880 }), port: 3000 })).toEqual({
      port: 17880, observed_port: 3000, port_source: 'catalog', port_mismatch: true,
    });
  });
  it('supports object snapshots and services without process observations', () => {
    expect(servicePortView({ catalog_snapshot: { port: 17880 }, port: null })).toMatchObject({ port: 17880, port_mismatch: false });
  });
  it('retains observations only when no port is declared', () => {
    expect(servicePortView({ catalog_snapshot: {}, port: 3000 })).toMatchObject({ port: 3000, port_source: 'observation' });
    expect(servicePortView({ catalog_snapshot: { port: null }, port: 3000 })).toMatchObject({ port: null, port_source: 'catalog' });
  });
  it('does not silently fall back from an invalid declaration', () => {
    for (const port of ['17880', 0, -1, 65536, 1.5]) {
      expect(servicePortView({ catalog_snapshot: { port }, port: 3000 })).toMatchObject({ port: null, port_source: 'invalid_catalog' });
    }
    expect(servicePortView({ catalog_snapshot: '{broken', port: 3000 }).port).toBeNull();
  });
});
