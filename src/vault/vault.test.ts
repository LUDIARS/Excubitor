import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKeyStore } from './keystore.js';
import { Vault } from './vault.js';
import { resolveVaultEnv } from './vault-inject.js';
import { buildVaultPublicRoutes } from './vault-federation.js';
import { buildVaultRouter } from './vault-router.js';
import type { RemotePeer } from '../federation/store.js';

let dir = '';
let vault: Vault;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'excubitor-vault-'));
  vault = new Vault({ dir, keyStore: createKeyStore(dir, 'linux'), now: () => 1_000 });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('Vault', () => {
  it('stores values encrypted and returns them only for bound services', async () => {
    await vault.setEntry('DATABASE_URL', 'postgres://user:hunter2@db/app');
    vault.setBindings('cernere', ['DATABASE_URL', 'API_KEY']);

    const onDisk = readFileSync(join(dir, 'vault.json'), 'utf8');
    expect(onDisk).not.toContain('hunter2');
    expect(await vault.envFor('cernere')).toEqual({ env: { DATABASE_URL: 'postgres://user:hunter2@db/app' }, missing: ['API_KEY'] });
    expect(await vault.envFor('actio')).toBeNull();
  });

  it('returns registered values by name for Excubitor itself, skipping unregistered names', async () => {
    await vault.setEntry('CF_API_TOKEN', 'cf-token');
    expect(await vault.valuesOf(['CF_API_TOKEN', 'CF_ACCOUNT_ID'])).toEqual({ CF_API_TOKEN: 'cf-token' });
    expect(await vault.valuesOf([])).toEqual({});
  });

  it('reports names, bindings and presence without values', async () => {
    await vault.setEntry('TOKEN', 'secret-value');
    vault.setBindings('actio', ['TOKEN', 'MISSING']);
    const status = vault.status();
    expect(JSON.stringify(status)).not.toContain('secret-value');
    expect(status.entries).toEqual([{ name: 'TOKEN', updated_at: 1_000, used_by: ['actio'] }]);
    expect(status.bindings.actio).toEqual([{ name: 'MISSING', present: false }, { name: 'TOKEN', present: true }]);
  });

  it('refuses a ciphertext moved under another name', async () => {
    await vault.setEntry('A', 'value-a');
    vault.setBindings('svc', ['B']);
    const path = join(dir, 'vault.json');
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    doc.entries.B = doc.entries.A;
    (await import('node:fs')).writeFileSync(path, JSON.stringify(doc));
    await expect(vault.envFor('svc')).rejects.toThrow();
  });

  it('rejects invalid environment variable names', async () => {
    await expect(vault.setEntry('bad-name', 'x')).rejects.toThrow(/invalid environment variable name/);
    expect(() => vault.setBindings('svc', ['1BAD'])).toThrow(/invalid environment variable name/);
  });

  it('keeps using the same key across instances (restart)', async () => {
    await vault.setEntry('TOKEN', 'persisted');
    vault.setBindings('svc', ['TOKEN']);
    const restarted = new Vault({ dir, keyStore: createKeyStore(dir, 'linux') });
    expect((await restarted.envFor('svc'))?.env).toEqual({ TOKEN: 'persisted' });
  });
});

describe('resolveVaultEnv', () => {
  const peer = { id: 'hq', name: 'hq', enabled: true } as RemotePeer;

  it('uses local values on the headquarters and stops on missing ones', async () => {
    await vault.setEntry('TOKEN', 'local');
    vault.setBindings('svc', ['TOKEN']);
    expect(await resolveVaultEnv('svc', { vault })).toEqual({ TOKEN: 'local' });
    vault.setBindings('svc', ['TOKEN', 'OTHER']);
    await expect(resolveVaultEnv('svc', { vault })).rejects.toThrow(/not set: OTHER/);
  });

  it('adds nothing when the node is neither headquarters nor configured with a source', async () => {
    expect(await resolveVaultEnv('svc', { vault })).toEqual({});
  });

  it('fetches from the headquarters on a branch and caches the values', async () => {
    vault.setSourcePeer('hq');
    const fetch = vi.fn(async () => ({ ok: true, status: 200, data: { env: { TOKEN: 'from-hq' }, missing: [] }, error: null }));
    expect(await resolveVaultEnv('svc', { vault, getPeer: () => peer, fetch })).toEqual({ TOKEN: 'from-hq' });
    expect(readFileSync(join(dir, 'vault.json'), 'utf8')).not.toContain('from-hq');

    const offline = vi.fn(async () => ({ ok: false, status: null, data: null, error: 'ECONNREFUSED' }));
    expect(await resolveVaultEnv('svc', { vault, getPeer: () => peer, fetch: offline })).toEqual({ TOKEN: 'from-hq' });
  });

  it('starts without Vault values when the headquarters is unreachable and nothing is cached', async () => {
    vault.setSourcePeer('hq');
    const offline = vi.fn(async () => ({ ok: false, status: null, data: null, error: 'timeout' }));
    expect(await resolveVaultEnv('svc', { vault, getPeer: () => peer, fetch: offline })).toEqual({});
  });

  it('treats a service without bindings on the headquarters as not using the Vault', async () => {
    vault.setSourcePeer('hq');
    const notBound = vi.fn(async () => ({ ok: false, status: 404, data: { error: 'not_bound' }, error: 'HTTP 404 not_bound' }));
    expect(await resolveVaultEnv('svc', { vault, getPeer: () => peer, fetch: notBound })).toEqual({});
  });
});

describe('resolveVaultEnv site overrides', () => {
  const peer = { id: 'hq', name: 'hq', enabled: true } as RemotePeer;
  const hq = (env: Record<string, string>, missing: string[] = []) =>
    vi.fn(async () => ({ ok: true, status: 200, data: { env, missing }, error: null }));
  const offline = vi.fn(async () => ({ ok: false, status: null, data: null, error: 'ECONNREFUSED' }));

  beforeEach(async () => {
    vault.setSourcePeer('hq');
    await vault.setEntry('DATABASE_URL', 'postgres://site');
    vault.setOverrides('cernere', ['DATABASE_URL']);
  });

  it('lets the site value win over the headquarters value', async () => {
    const fetch = hq({ DATABASE_URL: 'postgres://hq', OAUTH_SECRET: 'shared-oauth' });
    expect(await resolveVaultEnv('cernere', { vault, getPeer: () => peer, fetch }))
      .toEqual({ DATABASE_URL: 'postgres://site', OAUTH_SECRET: 'shared-oauth' });
  });

  it('stops with the name when an override value is not registered', async () => {
    vault.setOverrides('cernere', ['DATABASE_URL', 'FRONTEND_URL']);
    const fetch = hq({ FRONTEND_URL: 'https://hq', OAUTH_SECRET: 'shared-oauth' });
    await expect(resolveVaultEnv('cernere', { vault, getPeer: () => peer, fetch })).rejects.toThrow(/not set: FRONTEND_URL/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('caches only the headquarters values and overlays the site values on the cache', async () => {
    await resolveVaultEnv('cernere', { vault, getPeer: () => peer, fetch: hq({ DATABASE_URL: 'postgres://hq', OAUTH_SECRET: 'o' }) });
    expect((await vault.cachedEnv('cernere'))?.env).toEqual({ DATABASE_URL: 'postgres://hq', OAUTH_SECRET: 'o' });
    expect(await resolveVaultEnv('cernere', { vault, getPeer: () => peer, fetch: offline }))
      .toEqual({ DATABASE_URL: 'postgres://site', OAUTH_SECRET: 'o' });
  });

  it('resolves only the overrides when the headquarters has no binding', async () => {
    const notBound = vi.fn(async () => ({ ok: false, status: 404, data: { error: 'not_bound' }, error: 'HTTP 404 not_bound' }));
    expect(await resolveVaultEnv('cernere', { vault, getPeer: () => peer, fetch: notBound })).toEqual({ DATABASE_URL: 'postgres://site' });
  });

  it('does not stop on a headquarters-missing name that the site overrides', async () => {
    const fetch = hq({ OAUTH_SECRET: 'o' }, ['DATABASE_URL']);
    expect(await resolveVaultEnv('cernere', { vault, getPeer: () => peer, fetch })).toEqual({ DATABASE_URL: 'postgres://site', OAUTH_SECRET: 'o' });
  });

  it('keeps the all-local behaviour when the service has a local binding', async () => {
    await vault.setEntry('OAUTH_SECRET', 'local-oauth');
    vault.setBindings('cernere', ['OAUTH_SECRET']);
    const fetch = hq({ DATABASE_URL: 'postgres://hq' });
    expect(await resolveVaultEnv('cernere', { vault, getPeer: () => peer, fetch })).toEqual({ OAUTH_SECRET: 'local-oauth' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps the headquarters values for services without overrides', async () => {
    const fetch = hq({ DATABASE_URL: 'postgres://hq' });
    expect(await resolveVaultEnv('actio', { vault, getPeer: () => peer, fetch })).toEqual({ DATABASE_URL: 'postgres://hq' });
  });

  it('reports override names without values and removes them with an empty list', () => {
    const status = vault.status();
    expect(JSON.stringify(status)).not.toContain('postgres://site');
    expect(status.overrides).toEqual({ cernere: [{ name: 'DATABASE_URL', present: true }] });
    expect(status.entries).toEqual([{ name: 'DATABASE_URL', updated_at: 1_000, used_by: ['cernere'] }]);
    vault.setOverrides('cernere', []);
    expect(vault.status().overrides).toEqual({});
  });
});

describe('vault federation route', () => {
  const pass = async (c: { set: (k: 'federationCaller', v: unknown) => void }, next: () => Promise<void>) => {
    c.set('federationCaller', { peerId: 'branch', peerName: 'kaoimac', claimedNode: null });
    await next();
  };

  async function request(covers: boolean, service = 'svc') {
    await vault.setEntry('TOKEN', 'shared');
    vault.setBindings('svc', ['TOKEN']);
    const app = buildVaultPublicRoutes({ auth: pass as never, vault: () => vault, covers: () => covers });
    return app.request('/api/v1/federation/vault/env', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ service }),
    });
  }

  it('delivers values for a service the branch covers', async () => {
    const response = await request(true);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ env: { TOKEN: 'shared' }, missing: [] });
  });

  it('refuses services the branch does not cover', async () => {
    expect((await request(false)).status).toBe(403);
  });

  it('answers not_bound for services without Vault bindings', async () => {
    expect((await request(true, 'other')).status).toBe(404);
  });
});

describe('vault admin API', () => {
  function app(resolveInfisical?: never) {
    return buildVaultRouter({ vault: () => vault, getCatalogInfisical: () => undefined, peerExists: (id) => id === 'hq', resolveInfisical });
  }

  it('never returns values', async () => {
    const api = app();
    const put = await api.request('/api/v1/vault/entries/TOKEN', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'do-not-echo' }),
    });
    expect(put.status).toBe(200);
    const status = await api.request('/api/v1/vault');
    expect(await status.text()).not.toContain('do-not-echo');
  });

  it('rejects an unknown source peer and invalid names', async () => {
    const api = app();
    const source = await api.request('/api/v1/vault/source', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ peer_id: 'nobody' }),
    });
    expect(source.status).toBe(400);
    const bad = await api.request('/api/v1/vault/entries/bad-name', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'x' }),
    });
    expect(bad.status).toBe(400);
  });

  it('saves site overrides by name and rejects invalid names', async () => {
    const api = app();
    const put = (code: string, names: string[]) => api.request(`/api/v1/vault/overrides/${code}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ names }),
    });
    expect((await put('cernere', ['FRONTEND_URL'])).status).toBe(200);
    expect(((await (await api.request('/api/v1/vault')).json()) as { overrides: unknown }).overrides).toEqual({ cernere: [{ name: 'FRONTEND_URL', present: false }] });
    expect((await put('cernere', ['bad-name'])).status).toBe(400);
  });

  it('moves Infisical values into the Vault and binds them to the service', async () => {
    await vault.setEntry('EXISTING', 'keep');
    vault.setBindings('svc', ['EXISTING']);
    const resolveInfisical = vi.fn(async () => ({ ok: true as const, secrets: { API_KEY: 'k', DB_URL: 'u' }, projectId: 'p', environment: 'dev' }));
    const response = await app(resolveInfisical as never).request('/api/v1/vault/import/infisical/svc', { method: 'POST' });
    expect(await response.json()).toEqual({ ok: true, imported: ['API_KEY', 'DB_URL'], unchanged: [], conflicts: [], invalid: [] });
    expect((await vault.envFor('svc'))?.env).toEqual({ API_KEY: 'k', DB_URL: 'u', EXISTING: 'keep' });
  });

  it('keeps shared values and imports a different same-named project value', async () => {
    await vault.setEntry('DATABASE_URL', 'cernere-db');
    await vault.setEntry('SHARED', 'same');
    vault.setBindings('cernere', ['DATABASE_URL']);
    const resolveInfisical = vi.fn(async () => ({ ok: true as const, secrets: { DATABASE_URL: 'other-db', SHARED: 'same', NEW_KEY: 'n' }, projectId: 'p2', environment: 'dev' }));
    const response = await app(resolveInfisical as never).request('/api/v1/vault/import/infisical/other', { method: 'POST' });
    expect(await response.json()).toEqual({ ok: true, imported: ['DATABASE_URL', 'NEW_KEY', 'SHARED'], unchanged: [], conflicts: [], invalid: [] });
    expect((await vault.envFor('cernere'))?.env).toEqual({ DATABASE_URL: 'cernere-db' });
    expect(vault.forProject('p2').bindingsFor('other')).toEqual(['DATABASE_URL', 'NEW_KEY', 'SHARED']);
    expect((await vault.envFor('other'))?.env.DATABASE_URL).toBe('other-db');
  });
});

describe('DPAPI key store', () => {
  it.runIf(process.platform === 'win32')('round-trips the key through Windows DPAPI without writing it in the clear', async () => {
    const store = createKeyStore(dir, 'win32');
    const dpapiVault = new Vault({ dir, keyStore: store });
    await dpapiVault.setEntry('TOKEN', 'dpapi-value');
    dpapiVault.setBindings('svc', ['TOKEN']);
    const saved = readFileSync(join(dir, 'vault.key.dpapi'), 'utf8');
    const key = await store.load();
    expect(key?.length).toBe(32);
    expect(saved).not.toContain(key!.toString('base64'));
    const restarted = new Vault({ dir, keyStore: createKeyStore(dir, 'win32') });
    expect((await restarted.envFor('svc'))?.env).toEqual({ TOKEN: 'dpapi-value' });
  }, 60_000);
});
