import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Service } from '../catalog/loader.js';

const mocks = vi.hoisted(() => ({
  readIdentity: vi.fn(),
  fetchProjectSecrets: vi.fn(),
  getServiceByCode: vi.fn(),
  resolveServiceInfisical: vi.fn(),
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
}));

vi.mock('./service-registry.js', () => ({
  getServiceByCode: mocks.getServiceByCode,
}));

const { resolveRequiresSecretEnv } = await import('./inject.js');

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
