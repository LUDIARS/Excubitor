import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Service } from '../catalog/loader.js';
const mocks = vi.hoisted(() => ({ env: vi.fn(), identity: vi.fn(), fetch: vi.fn() }));
vi.mock('../process/inject.js', () => ({ resolveInjectEnv: mocks.env }));
vi.mock('../scanner/ports.js', () => ({ listListeners: async () => [] }));
vi.mock('../secrets/config-store.js', () => ({ resolveServiceInfisical: () => undefined }));
vi.mock('../secrets/infisical.js', () => ({ readIdentity: mocks.identity, fetchProjectSecrets: mocks.fetch }));
import { runPreflight } from './preflight.js';
const svc = { code: 'svc', name: 'Svc', runtime: 'node', cwd: process.cwd(), required_env: ['TOKEN'] } as Service;
beforeEach(() => vi.resetAllMocks());
describe('Vault-only preflight', () => {
  it('requires no identity and resolves exactly once', async () => {
    mocks.env.mockResolvedValue({ TOKEN: 'bound' });
    const result = await runPreflight([svc], ['svc']);
    expect(result.ok).toBe(true);
    expect(result.needsIdentity).toBe(false);
    expect(result.identityPresent).toBe(false);
    expect(mocks.env).toHaveBeenCalledTimes(1);
    expect(mocks.identity).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it.each([{}, { TOKEN: '' }])('fails missing or blank required env', async (env) => {
    mocks.env.mockResolvedValue(env);
    const result = await runPreflight([svc], ['svc']);
    expect(result.ok).toBe(false);
    expect(result.services[0]?.checks).toContainEqual({ kind: 'env', status: 'fail', detail: 'missing required env: TOKEN' });
  });
  it('reports binding failure even for a service with no required_env', async () => {
    mocks.env.mockRejectedValue(new Error('missing Vault binding'));
    const result = await runPreflight([{ ...svc, required_env: [] }], ['svc']);
    expect(result.services[0]?.ready).toBe(false);
    expect(result.services[0]?.checks).toContainEqual({ kind: 'vault', status: 'fail', detail: 'missing Vault binding' });
    expect(result.needsIdentity).toBe(false);
  });
});
