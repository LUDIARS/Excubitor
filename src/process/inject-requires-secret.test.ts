import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Service } from '../catalog/loader.js';

const mocks = vi.hoisted(() => ({
  vault: vi.fn<(code: string) => Promise<Record<string, string>>>(),
  mapping: vi.fn(), config: vi.fn(), fetch: vi.fn(), identity: vi.fn(),
}));
vi.mock('../vault/vault-inject.js', () => ({ resolveVaultEnv: mocks.vault }));
vi.mock('../secrets/infisical.js', () => ({ readIdentity: mocks.identity, fetchProjectSecrets: mocks.fetch }));
vi.mock('../secrets/config-store.js', () => ({
  getServiceRuntimeConfig: mocks.config, resolveServiceInfisical: mocks.mapping,
}));
vi.mock('./topology.js', () => ({ getTopologyEnv: () => ({ SAME: 'topology' }) }));
vi.mock('./service-version.js', () => ({
  injectServiceRuntimeVersion: async (_svc: Service, env: Record<string, string>) => ({ env }),
}));
import { resolveInjectEnv, resolveRequiresSecretEnv } from './inject.js';

const service = (patch: Partial<Service> = {}): Service => ({
  code: 'consumer', name: 'Consumer', runtime: 'node', required_env: [], ...patch,
} as Service);
const requiring = () => service({ requires_secret: [{ service: 'source', keys: ['A', 'B'] }] });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.vault.mockResolvedValue({});
  mocks.config.mockReturnValue(null);
  mocks.identity.mockImplementation(() => { throw new Error('identity must not be read'); });
  mocks.fetch.mockImplementation(() => { throw new Error('Infisical must not be fetched'); });
});

describe('Vault-only requirements', () => {
  it('uses consumer bindings, never the source service project', async () => {
    mocks.vault.mockResolvedValue({ A: 'a', B: 'b', PRIVATE: 'unrequested' });
    expect(await resolveRequiresSecretEnv(requiring())).toEqual({ A: 'a', B: 'b' });
    expect(mocks.vault).toHaveBeenCalledTimes(1);
    expect(mocks.vault).toHaveBeenCalledWith('consumer');
    expect(mocks.identity).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('reuses a resolved snapshot', async () => {
    expect(await resolveRequiresSecretEnv(requiring(), { A: 'a', B: 'b' })).toEqual({ A: 'a', B: 'b' });
    expect(mocks.vault).not.toHaveBeenCalled();
  });
  it.each([{}, { A: 'a' }, { A: 'a', B: '' }, { A: 'a', B: '  ' }])('rejects missing or blank keys without fallback: %j', async (env) => {
    mocks.vault.mockResolvedValue(env as Record<string, string>);
    await expect(resolveRequiresSecretEnv(requiring())).rejects.toThrow(/missing required Vault bindings or values/);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('does not read Vault when there are no requirements', async () => {
    expect(await resolveRequiresSecretEnv(service())).toEqual({});
    expect(mocks.vault).not.toHaveBeenCalled();
  });
});

describe('Vault-only spawn environment', () => {
  it('ignores legacy Infisical fetch even when inject is true', async () => {
    mocks.mapping.mockReturnValue({ inject: true, project_id: 'old', environment: 'dev' });
    mocks.vault.mockResolvedValue({ SAME: 'vault' });
    expect((await resolveInjectEnv(service({ env: { SAME: 'catalog' } }))).SAME).toBe('vault');
    expect(mocks.identity).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('fails an unmigrated inject service explicitly', async () => {
    mocks.mapping.mockReturnValue({ inject: true });
    await expect(resolveInjectEnv(service())).rejects.toThrow(/requires Vault bindings/);
  });
  it('propagates incomplete project bindings rather than using static env', async () => {
    mocks.vault.mockRejectedValue(new Error('service consumer uses Vault values that are not set: TOKEN'));
    await expect(resolveInjectEnv(service({ env: { TOKEN: 'static' } }))).rejects.toThrow(/not set: TOKEN/);
  });
  it('resolves once for requires_secret and injects runtime config only into its service', async () => {
    mocks.vault.mockResolvedValue({ A: 'a', B: 'b' });
    mocks.config.mockImplementation((code: string) => code === 'consumer' ? { model: 'example' } : null);
    const env = await resolveInjectEnv(requiring());
    expect(env.EXCUBITOR_SERVICE_CONFIG_JSON).toBe('{"model":"example"}');
    expect(mocks.vault).toHaveBeenCalledTimes(1);
    expect((await resolveInjectEnv(service({ code: 'other' }))).EXCUBITOR_SERVICE_CONFIG_JSON).toBeUndefined();
  });
  it('preserves Vault precedence over encrypted runtime config', async () => {
    mocks.config.mockReturnValue({ model: 'config' });
    mocks.vault.mockResolvedValue({ EXCUBITOR_SERVICE_CONFIG_JSON: '{"model":"vault"}' });
    expect((await resolveInjectEnv(service())).EXCUBITOR_SERVICE_CONFIG_JSON).toBe('{"model":"vault"}');
  });
});
