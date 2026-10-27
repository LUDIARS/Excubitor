import { describe, it, expect, vi } from 'vitest';
import { intrusionConfigSchema } from './config.js';
import { planGatewayRoutes } from './route-plan.js';
import { verifyCoverage } from './coverage.js';
import { config } from './test-fixtures.js';
import { privateHttpOriginPort } from './origin.js';

const restricted = intrusionConfigSchema.parse({ ...config, routes: [
  { ...config.routes[0], path: '^/share/', routeKey: 'r-share.intrusion.invalid', forwardHost: 'origin.internal' },
  { ...config.routes[0], path: '^/hooks/', routeKey: 'r-hooks.intrusion.invalid', origin: 'http://100.64.0.1:8080' },
] });
const original = { ingress: [
  { hostname: 'app.example.com', path: '^/share/', service: 'http://localhost:8080',
    originRequest: { httpHostHeader: 'origin.internal', access: { required: true, audTag: ['aud'] } } },
  { hostname: 'app.example.com', path: '^/hooks/', service: 'http://100.64.0.1:8080' },
  { service: 'http_status:404' },
] };

describe('existing public route migration', () => {
  it('preserves path, Access, rule order and fallback without altering the source snapshot', async () => {
    const snapshot = structuredClone(original);
    const plan = planGatewayRoutes(original, restricted, config.tunnels[0]!.id, 9000);
    expect(original).toEqual(snapshot);
    expect(plan.ingress?.map(rule => rule.path)).toEqual(['^/share/', '^/hooks/', undefined]);
    expect(plan.ingress?.[0]?.originRequest).toEqual({ httpHostHeader: 'r-share.intrusion.invalid',
      access: { required: true, audTag: ['aud'] } });
    expect(plan.ingress?.at(-1)).toEqual({ service: 'http_status:404' });
    const api = { getConfiguration: vi.fn().mockResolvedValue(plan), putConfiguration: vi.fn() };
    expect((await verifyCoverage(api, restricted, 9000)).state).toBe('configured_tunnels_verified');
    expect(api.putConfiguration).not.toHaveBeenCalled();
  });

  it('rejects missing selectors, stale origins and widened paths', async () => {
    expect(() => planGatewayRoutes({ ingress: [] }, restricted, config.tunnels[0]!.id, 9000)).toThrow();
    const changed = structuredClone(original);
    changed.ingress[0]!.service = 'http://127.0.0.1:8081';
    expect(() => planGatewayRoutes(changed, restricted, config.tunnels[0]!.id, 9000)).toThrow();
    const plan = planGatewayRoutes(original, restricted, config.tunnels[0]!.id, 9000);
    delete plan.ingress![0]!.path;
    const api = { getConfiguration: vi.fn().mockResolvedValue(plan), putConfiguration: vi.fn() };
    expect((await verifyCoverage(api, restricted, 9000)).state).toBe('incomplete');
  });

  it('rejects wrong internal Host and direct upstream bypass', async () => {
    const plan = planGatewayRoutes(original, restricted, config.tunnels[0]!.id, 9000);
    plan.ingress![0]!.originRequest = { httpHostHeader: 'app.example.com' };
    const api = { getConfiguration: vi.fn().mockResolvedValue(plan), putConfiguration: vi.fn() };
    expect((await verifyCoverage(api, restricted, 9000)).state).toBe('incomplete');
    plan.ingress![1]!.service = 'http://100.64.0.1:8080';
    expect((await verifyCoverage(api, restricted, 9000)).state).toBe('incomplete');
  });
});

describe('route configuration boundary', () => {
  it.each(['http://8.8.8.8:8080', 'http://169.254.169.254:80', 'http://example.com:8080',
    'http://user:pass@127.0.0.1:8080', 'https://127.0.0.1:8080', 'http://127.0.0.1:0',
    'http://127.0.0.1:65536', 'http://0x7f000001:8080', 'not a URL'])(
    'rejects non-private or unsupported origin %s', origin => {
      expect(intrusionConfigSchema.safeParse({ ...config, routes: [{ ...config.routes[0], origin }] }).success).toBe(false);
    });
  it('accepts an explicitly written default HTTP port', () => {
    const input = { ...config, routes: [{ ...config.routes[0], origin: 'http://127.0.0.1:80' }] };
    expect(intrusionConfigSchema.safeParse(input).success).toBe(true);
    expect(privateHttpOriginPort(input.routes[0]!.origin)).toBe(80);
  });
  it('requires a unique internal key for each path route', () => {
    const routes = restricted.routes.map(route => ({ ...route, routeKey: 'r-same.intrusion.invalid' }));
    expect(intrusionConfigSchema.safeParse({ ...restricted, routes }).success).toBe(false);
    const { routeKey: _key, ...withoutKey } = routes[0]!;
    expect(intrusionConfigSchema.safeParse({ ...restricted, routes: [withoutKey, routes[1]] }).success).toBe(false);
  });
});
