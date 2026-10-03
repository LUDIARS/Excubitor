import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ vault: vi.fn(), identity: vi.fn(), fetch: vi.fn() }));
vi.mock('../vault/vault-inject.js', () => ({ resolveVaultEnv: mocks.vault }));
vi.mock('./infisical.js', () => ({ readIdentity: mocks.identity, fetchProjectSecrets: mocks.fetch }));
vi.mock('./agent-token.js', () => ({ verifyAgentToken: (value: string) => value === 'Bearer test-token' }));
import { resolveServiceSecrets } from './resolve.js';
import { buildSecretAgentRouter } from './agent-router.js';
beforeEach(() => { vi.resetAllMocks(); mocks.vault.mockResolvedValue({ A: 'a', B: 'b' }); });
describe('Vault secret-agent', () => {
  it('returns only service-bound requested keys without Infisical metadata', async () => {
    expect(await resolveServiceSecrets('svc', undefined, ['A'])).toEqual({ ok: true, secrets: { A: 'a' }, projectId: null, environment: null });
    expect(mocks.vault).toHaveBeenCalledWith('svc');
    expect(mocks.identity).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('rejects a request containing any unbound key atomically', async () => {
    expect(await resolveServiceSecrets('svc', undefined, ['A', 'OTHER_PROJECT'])).toMatchObject({ ok: false, code: 'keys_not_bound' });
  });
  it('rejects inherited properties as keys', async () => {
    expect(await resolveServiceSecrets('svc', undefined, ['toString'])).toMatchObject({ ok: false, code: 'keys_not_bound' });
  });
  it('ignores legacy project selection and fails unknown bindings', async () => {
    mocks.vault.mockResolvedValue({});
    expect(await resolveServiceSecrets('unknown', { project_id: 'other-project', environment: 'prod', inject: true, prefix: '' })).toMatchObject({ ok: false, code: 'no_mapping' });
  });
  it('does not leak raw transport or storage errors', async () => {
    mocks.vault.mockRejectedValue(new Error('private-upstream-body'));
    expect(await resolveServiceSecrets('svc')).toEqual({ ok: false, code: 'fetch_failed', message: 'service Vault resolution failed' });
  });
  it('keeps token authentication and publishes the Vault response contract', async () => {
    const legacy = vi.fn(() => undefined);
    const app = buildSecretAgentRouter(legacy);
    const request = (keys: string[], token = 'test-token') => app.request('/api/v1/secrets/resolve', {
      method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ service: 'svc', keys }),
    });
    expect((await request(['A'], 'wrong')).status).toBe(401);
    expect(mocks.vault).not.toHaveBeenCalled();
    expect((await request(['UNBOUND'])).status).toBe(403);
    const response = await request(['A']);
    expect(await response.json()).toEqual({ secrets: { A: 'a' }, project_id: null, environment: null, source: 'vault' });
    expect(legacy).not.toHaveBeenCalled();
  });
});
