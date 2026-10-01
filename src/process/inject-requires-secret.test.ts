import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Service } from '../catalog/loader.js';
import type { ServiceRuntimeConfig } from '../secrets/config-store.js';

const mocks = vi.hoisted(() => ({
  readIdentity: vi.fn(),
  fetchProjectSecrets: vi.fn(),
  getServiceByCode: vi.fn(),
  resolveServiceInfisical: vi.fn(),
  getServiceRuntimeConfig: vi.fn<(code: string) => ServiceRuntimeConfig | null>(() => null),
  resolveVaultEnv: vi.fn<(code: string) => Promise<Record<string, string>>>(async () => ({})),
}));

vi.mock('../secrets/infisical.js', () => ({
  readIdentity: mocks.readIdentity,
  hasIdentity: vi.fn(() => true),
  fetchProjectSecrets: mocks.fetchProjectSecrets,
  toEnvMap: (
    secrets: Array<{ secretKey: string; secretValue: string }>,
    filter: { prefix?: string; include?: string[]; exclude?: string[] } = {},
  ) => {
    const include = filter.include ? new Set(filter.include) : null;
    const exclude = filter.exclude ? new Set(filter.exclude) : null;
    const prefix = filter.prefix ?? '';
    const out: Record<string, string> = {};
    for (const s of secrets) {
      if (include && !include.has(s.secretKey)) continue;
      if (exclude && exclude.has(s.secretKey)) continue;
      out[`${prefix}${s.secretKey}`] = s.secretValue;
    }
    return out;
  },
}));

vi.mock('../secrets/config-store.js', () => ({
  resolveServiceInfisical: mocks.resolveServiceInfisical,
  getServiceRuntimeConfig: mocks.getServiceRuntimeConfig,
}));

vi.mock('./service-registry.js', () => ({
  getServiceByCode: mocks.getServiceByCode,
}));

// Vault は実ファイル (config.enc の隣) と鍵保管を読むので、ここでは切り離す (既定は空)。
vi.mock('../vault/vault-inject.js', () => ({
  resolveVaultEnv: mocks.resolveVaultEnv,
}));

const { resolveInjectEnv, resolveRequiresSecretEnv } = await import('./inject.js');

function service(patch: Partial<Service>): Service {
  return {
    code: 'aedilis',
    name: 'Aedilis',
    runtime: 'node',
    disabled: false,
    monitor_only: false,
    autostart: false,
    restart_policy: 'no',
    max_restart: 5,
    required_env: [],
    ...patch,
  } as unknown as Service;
}

const cernereSource: Service = service({
  code: 'cernere',
  infisical: {
    project_id: 'cernere-project',
    environment: 'dev',
    inject: true,
    prefix: '',
  },
});

describe('resolveRequiresSecretEnv', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readIdentity.mockReturnValue({ siteUrl: 'https://x', clientId: 'c', clientSecret: 's' });
    mocks.resolveVaultEnv.mockResolvedValue({});
  });

  it('returns only the requested keys from the source service secrets', async () => {
    mocks.getServiceByCode.mockReturnValue(cernereSource);
    mocks.resolveServiceInfisical.mockReturnValue(cernereSource.infisical);
    mocks.fetchProjectSecrets.mockResolvedValue([
      { secretKey: 'AEDILIS_CERNERE_CLIENT_ID', secretValue: 'id-1' },
      { secretKey: 'AEDILIS_CERNERE_CLIENT_SECRET', secretValue: 'secret-1' },
      { secretKey: 'CERNERE_INTERNAL_ONLY', secretValue: 'should-not-leak' },
    ]);

    const svc = service({
      requires_secret: [{ service: 'cernere', keys: ['AEDILIS_CERNERE_CLIENT_ID', 'AEDILIS_CERNERE_CLIENT_SECRET'] }],
    });

    const env = await resolveRequiresSecretEnv(svc);

    expect(env).toEqual({
      AEDILIS_CERNERE_CLIENT_ID: 'id-1',
      AEDILIS_CERNERE_CLIENT_SECRET: 'secret-1',
    });
    expect(mocks.fetchProjectSecrets).toHaveBeenCalledWith(
      expect.anything(),
      'cernere-project',
      'dev',
    );
  });

  it('returns empty object when no requires_secret configured', async () => {
    const svc = service({});
    expect(await resolveRequiresSecretEnv(svc)).toEqual({});
    expect(mocks.fetchProjectSecrets).not.toHaveBeenCalled();
  });

  it('throws when the source service is not registered in the catalog', async () => {
    mocks.getServiceByCode.mockReturnValue(undefined);

    const svc = service({ requires_secret: [{ service: 'unknown-service', keys: ['SOME_KEY'] }] });

    await expect(resolveRequiresSecretEnv(svc)).rejects.toThrow(/unknown service "unknown-service"/);
    expect(mocks.fetchProjectSecrets).not.toHaveBeenCalled();
  });

  it('throws when the source service has no infisical config', async () => {
    mocks.getServiceByCode.mockReturnValue(service({ code: 'no-infisical-svc' }));
    mocks.resolveServiceInfisical.mockReturnValue(undefined);

    const svc = service({ requires_secret: [{ service: 'no-infisical-svc', keys: ['SOME_KEY'] }] });

    await expect(resolveRequiresSecretEnv(svc)).rejects.toThrow(/no infisical config/);
    expect(mocks.fetchProjectSecrets).not.toHaveBeenCalled();
  });

  it('throws when Excubitor has no machine identity', async () => {
    mocks.readIdentity.mockReturnValue(null);
    mocks.getServiceByCode.mockReturnValue(cernereSource);
    mocks.resolveServiceInfisical.mockReturnValue(cernereSource.infisical);

    const svc = service({ requires_secret: [{ service: 'cernere', keys: ['AEDILIS_CERNERE_CLIENT_ID'] }] });

    await expect(resolveRequiresSecretEnv(svc)).rejects.toThrow(/no machine identity/);
    expect(mocks.fetchProjectSecrets).not.toHaveBeenCalled();
  });
});

describe('resolveRequiresSecretEnv with Vault values', () => {
  const glab = (): Service =>
    service({
      code: 'glab',
      requires_secret: [
        { service: 'cernere', keys: ['EXCUBITOR_CERNERE_CLIENT_ID', 'EXCUBITOR_CERNERE_CLIENT_SECRET'] },
      ],
    });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readIdentity.mockReturnValue({ siteUrl: 'https://x', clientId: 'c', clientSecret: 's' });
    mocks.getServiceByCode.mockReturnValue(cernereSource);
    mocks.resolveServiceInfisical.mockReturnValue(cernereSource.infisical);
  });

  it('does not touch Infisical when the Vault binding provides every requested key', async () => {
    mocks.resolveVaultEnv.mockResolvedValue({
      EXCUBITOR_CERNERE_CLIENT_ID: 'vault-id',
      EXCUBITOR_CERNERE_CLIENT_SECRET: 'vault-secret',
      UNRELATED_VAULT_KEY: 'not-requested',
    });
    // Infisical login is failing (502) in production; it must not matter here.
    mocks.readIdentity.mockReturnValue(null);
    mocks.fetchProjectSecrets.mockRejectedValue(new Error('Infisical login failed: 502'));

    const env = await resolveRequiresSecretEnv(glab());

    expect(env).toEqual({
      EXCUBITOR_CERNERE_CLIENT_ID: 'vault-id',
      EXCUBITOR_CERNERE_CLIENT_SECRET: 'vault-secret',
    });
    expect(mocks.resolveVaultEnv).toHaveBeenCalledWith('glab');
    expect(mocks.readIdentity).not.toHaveBeenCalled();
    expect(mocks.fetchProjectSecrets).not.toHaveBeenCalled();
  });

  it('uses Vault values passed by the caller without resolving the Vault again', async () => {
    const env = await resolveRequiresSecretEnv(glab(), {
      EXCUBITOR_CERNERE_CLIENT_ID: 'vault-id',
      EXCUBITOR_CERNERE_CLIENT_SECRET: 'vault-secret',
    });

    expect(env.EXCUBITOR_CERNERE_CLIENT_ID).toBe('vault-id');
    expect(mocks.resolveVaultEnv).not.toHaveBeenCalled();
    expect(mocks.fetchProjectSecrets).not.toHaveBeenCalled();
  });

  it('fetches only the keys missing from the Vault from Infisical', async () => {
    mocks.resolveVaultEnv.mockResolvedValue({ EXCUBITOR_CERNERE_CLIENT_ID: 'vault-id' });
    mocks.fetchProjectSecrets.mockResolvedValue([
      { secretKey: 'EXCUBITOR_CERNERE_CLIENT_ID', secretValue: 'infisical-id' },
      { secretKey: 'EXCUBITOR_CERNERE_CLIENT_SECRET', secretValue: 'infisical-secret' },
    ]);

    const env = await resolveRequiresSecretEnv(glab());

    expect(env).toEqual({
      EXCUBITOR_CERNERE_CLIENT_ID: 'vault-id',
      EXCUBITOR_CERNERE_CLIENT_SECRET: 'infisical-secret',
    });
    expect(mocks.fetchProjectSecrets).toHaveBeenCalledTimes(1);
    expect(mocks.fetchProjectSecrets).toHaveBeenCalledWith(expect.anything(), 'cernere-project', 'dev');
  });

  it('still throws when a key is not in the Vault and there is no machine identity', async () => {
    mocks.resolveVaultEnv.mockResolvedValue({ EXCUBITOR_CERNERE_CLIENT_ID: 'vault-id' });
    mocks.readIdentity.mockReturnValue(null);

    await expect(resolveRequiresSecretEnv(glab())).rejects.toThrow(
      /no machine identity.*EXCUBITOR_CERNERE_CLIENT_SECRET/,
    );
    expect(mocks.fetchProjectSecrets).not.toHaveBeenCalled();
  });

  it('still throws when an Infisical fetch for a missing key fails', async () => {
    mocks.resolveVaultEnv.mockResolvedValue({});
    mocks.fetchProjectSecrets.mockRejectedValue(new Error('Infisical login failed: 502'));

    await expect(resolveRequiresSecretEnv(glab())).rejects.toThrow(/Infisical login failed: 502/);
  });
});

describe('resolveInjectEnv runtime configuration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveVaultEnv.mockResolvedValue({});
    mocks.readIdentity.mockReturnValue({ siteUrl: 'https://x', clientId: 'c', clientSecret: 's' });
    mocks.fetchProjectSecrets.mockResolvedValue([]);
    mocks.resolveServiceInfisical.mockReturnValue(undefined);
    mocks.getServiceRuntimeConfig.mockReturnValue(null);
  });

  it('injects a stored runtime config only into the target service environment', async () => {
    const runtimeConfig = { dataDir: './data', embedding: { model: 'bge-m3' } };
    mocks.getServiceRuntimeConfig.mockImplementation((code) => code === 'genius' ? runtimeConfig : null);

    const geniusEnv = await resolveInjectEnv(service({ code: 'genius' }));
    const otherServiceEnv = await resolveInjectEnv(service({ code: 'aedilis' }));

    expect(geniusEnv.EXCUBITOR_SERVICE_CONFIG_JSON).toBe(JSON.stringify(runtimeConfig));
    expect(otherServiceEnv.EXCUBITOR_SERVICE_CONFIG_JSON).toBeUndefined();
  });

  it('lets an explicitly mapped Infisical secret override the stored runtime config env', async () => {
    mocks.getServiceRuntimeConfig.mockReturnValue({ dataDir: './data' });
    mocks.resolveServiceInfisical.mockReturnValue({
      project_id: 'genius-project',
      environment: 'dev',
      inject: true,
      prefix: '',
    });
    mocks.fetchProjectSecrets.mockResolvedValue([
      { secretKey: 'EXCUBITOR_SERVICE_CONFIG_JSON', secretValue: '{"dataDir":"from-secret"}' },
    ]);

    const env = await resolveInjectEnv(service({ code: 'genius' }));

    expect(env.EXCUBITOR_SERVICE_CONFIG_JSON).toBe('{"dataDir":"from-secret"}');
  });

  it('does not add a runtime configuration when the service has none', async () => {
    const env = await resolveInjectEnv(service({ code: 'genius' }));

    expect(env.EXCUBITOR_SERVICE_CONFIG_JSON).toBeUndefined();
  });
});
