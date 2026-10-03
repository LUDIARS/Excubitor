import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveServiceInfisical, type ServiceInfisical } from '../secrets/config-store.js';
import { fetchProjectSecrets, readIdentity } from '../secrets/infisical.js';
import { resolveInfisicalForImport } from './infisical-import-resolve.js';

vi.mock('../secrets/config-store.js', () => ({ resolveServiceInfisical: vi.fn() }));
vi.mock('../secrets/infisical.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../secrets/infisical.js')>();
  return { ...original, readIdentity: vi.fn(), fetchProjectSecrets: vi.fn() };
});

const mapping: ServiceInfisical = {
  project_id: 'real-project-id', environment: 'production', inject: true,
  prefix: 'APP_', include: ['TOKEN', 'SKIP'], exclude: ['SKIP'],
};
const identity = { siteUrl: 'https://infisical.example', clientId: 'client', clientSecret: 'secret' };

describe('single-service Infisical import resolution', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(resolveServiceInfisical).mockReturnValue(mapping);
    vi.mocked(readIdentity).mockReturnValue(identity);
  });

  it('uses the effective mapping, filters values, and retains the real project metadata', async () => {
    vi.mocked(fetchProjectSecrets).mockResolvedValue([
      { secretKey: 'TOKEN', secretValue: 'value' },
      { secretKey: 'SKIP', secretValue: 'excluded' },
      { secretKey: 'OTHER', secretValue: 'not-included' },
    ]);

    expect(await resolveInfisicalForImport('svc', mapping)).toEqual({
      ok: true, secrets: { APP_TOKEN: 'value' }, projectId: 'real-project-id', environment: 'production',
    });
    expect(resolveServiceInfisical).toHaveBeenCalledWith('svc', mapping);
    expect(fetchProjectSecrets).toHaveBeenCalledWith(identity, 'real-project-id', 'production');
  });

  it('fails before fetching when the mapping or identity is missing', async () => {
    vi.mocked(resolveServiceInfisical).mockReturnValueOnce(undefined);
    expect(await resolveInfisicalForImport('unknown')).toMatchObject({ ok: false, code: 'no_mapping' });
    vi.mocked(readIdentity).mockReturnValueOnce(null);
    expect(await resolveInfisicalForImport('svc')).toMatchObject({ ok: false, code: 'no_identity' });
    expect(fetchProjectSecrets).not.toHaveBeenCalled();
  });

  it('preserves a fetch failure as an import error', async () => {
    vi.mocked(fetchProjectSecrets).mockRejectedValue(new Error('Infisical secrets fetch failed: 403'));
    expect(await resolveInfisicalForImport('svc')).toEqual({
      ok: false, code: 'fetch_failed', message: 'Infisical secrets fetch failed: 403',
    });
  });
});
