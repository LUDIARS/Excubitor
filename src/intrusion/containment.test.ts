import { describe, it, expect, vi } from 'vitest';
import { blockedIngress, containTunnels } from './containment.js';
import { config } from './test-fixtures.js';

describe('public tunnel containment', () => {
  const ingress = [{ hostname: 'app.example.com', service: 'http://127.0.0.1:8080',
    originRequest: { access: { required: true } } },
  { hostname: 'other.example.com', service: 'http://127.0.0.1:8081' }, { service: 'http_status:404' }];
  it('retains Access, unrelated routes and the catch-all', () => {
    const result = blockedIngress(ingress, ['app.example.com']);
    expect(result[0]).toEqual({ ...ingress[0], service: 'http_status:503' });
    expect(result.slice(1)).toEqual(ingress.slice(1));
    expect(ingress[0]?.service).toBe('http://127.0.0.1:8080');
  });
  it('does not infer success for an absent hostname', () => {
    expect(() => blockedIngress(ingress, ['absent.example.com'])).toThrow();
  });
  it('saves original state before a write and confirms readback', async () => {
    const saved = vi.fn();
    const getConfiguration = vi.fn().mockResolvedValueOnce({ ingress })
      .mockResolvedValueOnce({ ingress: blockedIngress(ingress, ['app.example.com']) });
    const putConfiguration = vi.fn(async () => {
      expect(saved).toHaveBeenCalledOnce();
      return {};
    });
    await containTunnels({ getConfiguration, putConfiguration }, config, ['app.example.com'], saved);
    expect(putConfiguration).toHaveBeenCalledOnce();
  });
  it('treats stale readback as failure and never writes outside the allowlist', async () => {
    const api = { getConfiguration: vi.fn().mockResolvedValue({ ingress }), putConfiguration: vi.fn().mockResolvedValue({}) };
    await expect(containTunnels(api, config, [], vi.fn())).rejects.toThrow();
    expect(api.putConfiguration).not.toHaveBeenCalled();
    await expect(containTunnels(api, config, ['app.example.com'], vi.fn())).rejects.toThrow();
  });
});
