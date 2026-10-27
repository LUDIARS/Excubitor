import { describe, it, expect, vi } from 'vitest';
import { verifyCoverage } from './coverage.js';
import { config } from './test-fixtures.js';

describe('coverage preflight', () => {
  it('rejects direct origins and uncovered hosts even when the gateway is running', async () => {
    const api = { getConfiguration: vi.fn().mockResolvedValue({ ingress: [
      { hostname: 'app.example.com', service: 'http://127.0.0.1:8080' },
      { hostname: 'other.example.com', service: 'http://127.0.0.1:8090' },
      { service: 'http_status:404' },
    ] }), putConfiguration: vi.fn() };
    const result = await verifyCoverage(api, config, 9000);
    expect(result.state).toBe('incomplete');
    expect(result.gaps).toHaveLength(2);
    expect(api.putConfiguration).not.toHaveBeenCalled();
  });
  it('only verifies configured tunnels after all their public paths are gateway-bound', async () => {
    const api = { getConfiguration: vi.fn().mockResolvedValue({ ingress: [
      { hostname: 'app.example.com', service: 'http://127.0.0.1:9000' }, { service: 'http_status:404' },
    ] }), putConfiguration: vi.fn() };
    expect((await verifyCoverage(api, config, 9000)).state).toBe('configured_tunnels_verified');
  });
});
