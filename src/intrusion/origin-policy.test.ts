import { describe, expect, it } from 'vitest';
import type { Catalog } from '../catalog/loader.js';
import { config } from './test-fixtures.js';
import { validateOriginTargets } from './origin-policy.js';

const catalog = { services: [
  { code: 'excubitor', port: 17332, ports: [{ port: 17335, role: 'federation' }, { port: 17336, role: 'public-ingress' }] },
  { code: 'app', port: 8080 },
] } as unknown as Catalog;
const adopted = { ...config, routes: [{ ...config.routes[0]!, routeKey: 'r-existing.intrusion.invalid',
  adoptExisting: { tunnelId: config.tunnels[0]!.id, sourceHash: 'a'.repeat(64) } }] };

describe('origin target policy', () => {
  it('preserves catalog defaults while allowing explicitly adopted legacy origins', () => {
    expect(validateOriginTargets(catalog, config, 17336).size).toBe(0);
    const legacy = { ...adopted, routes: [{ ...adopted.routes[0]!, service: 'legacy', origin: 'http://127.0.0.1:8081' }] };
    expect(validateOriginTargets(catalog, legacy, 17336).size).toBe(0);
    expect(() => validateOriginTargets(catalog, { ...legacy, routes: [{ ...legacy.routes[0]!, adoptExisting: undefined }] }, 17336)).toThrow();
  });
  it('marks management for Access verification and never admits recursive/federation targets', () => {
    const route = { ...adopted.routes[0]!, service: 'excubitor', origin: 'http://127.0.0.1:17332' };
    expect([...validateOriginTargets(catalog, { ...adopted, routes: [route] }, 17336)]).toEqual([route.routeKey]);
    for (const port of [17335, 17336]) {
      expect(() => validateOriginTargets(catalog, { ...adopted, routes: [{ ...route, origin: `http://127.0.0.1:${port}` }] }, 17336)).toThrow();
    }
    expect(() => validateOriginTargets(catalog, { ...adopted, routes: [{ ...route, adoptExisting: undefined }] }, 17336)).toThrow();
  });
});
