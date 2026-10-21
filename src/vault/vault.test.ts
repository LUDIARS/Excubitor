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
  const notify = vi.fn();
  beforeEach(() => notify.mockClear());

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

  });

  it('starts from the last good cache on a transient outage and reports it', async () => {
    vault.setSourcePeer('hq');
    const ok = vi.fn(async () => ({ ok: true, status: 200, data: { env: { TOKEN: 'from-hq' }, missing: [] }, error: null }));
    await resolveVaultEnv('svc', { vault, getPeer: () => peer, fetch: ok, notify });
    for (const failure of [
      { ok: false, status: null, data: null, error: 'ECONNREFUSED' },
      { ok: false, status: null, data: null, error: 'The operation was aborted due to timeout' },
      { ok: false, status: 503, data: { error: 'mesh_security_unavailable' }, error: 'HTTP 503' },
    ]) {
      notify.mockClear();
      expect(await resolveVaultEnv('svc', { vault, getPeer: () => peer, fetch: async () => failure, notify })).toEqual({ TOKEN: 'from-hq' });
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'cache-used', code: 'svc', fetchedAt: 1_000 }));
    }
  });

  it('does not use and discards the cache when HQ revokes or refuses', async () => {
    vault.setSourcePeer('hq');
    const ok = vi.fn(async () => ({ ok: true, status: 200, data: { env: { TOKEN: 'from-hq' }, missing: [] }, error: null }));
    for (const refusal of [
      { ok: false, status: 403, data: { error: 'vault_grant_required' }, error: 'HTTP 403' },
      { ok: false, status: 401, data: { error: 'workload_authentication_failed' }, error: 'HTTP 401' },
      { ok: false, status: null, data: null, error: 'peer_auth_not_configured' },
    ]) {
      await resolveVaultEnv('svc', { vault, getPeer: () => peer, fetch: ok, notify });
      await expect(resolveVaultEnv('svc', { vault, getPeer: () => peer, fetch: async () => refusal, notify }))
        .rejects.toThrow('vault_authorization_revoked');
      expect(await vault.cachedEnv('svc')).toBeNull();
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'cache-discarded' }));
      // The discarded cache is not used by a later transient outage either.
      const offline = vi.fn(async () => ({ ok: false, status: null, data: null, error: 'ECONNREFUSED' }));
      await expect(resolveVaultEnv('svc', { vault, getPeer: () => peer, fetch: offline, notify })).rejects.toThrow('vault_authorization_unavailable');
    }
  });

  it('fails the start of a service that forbids cache fallback, without keeping a cache', async () => {
    vault.setSourcePeer('hq');
    const ok = vi.fn(async () => ({ ok: true, status: 200, data: { env: { TOKEN: 'from-hq' }, missing: [] }, error: null }));
    await resolveVaultEnv('svc', { vault, getPeer: () => peer, fetch: ok, notify });
    const strict = { vault, getPeer: () => peer, notify, cacheFallbackAllowed: () => false };
    expect(await resolveVaultEnv('svc', { ...strict, fetch: ok })).toEqual({ TOKEN: 'from-hq' });
    expect(await vault.cachedEnv('svc')).toBeNull();
    const offline = vi.fn(async () => ({ ok: false, status: null, data: null, error: 'ECONNREFUSED' }));
    await expect(resolveVaultEnv('svc', { ...strict, fetch: offline })).rejects.toThrow('vault_cache_fallback_disabled');
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'fallback-disabled' }));
  });

  it('refuses new secret resolution when current authorization is unavailable', async () => {
    vault.setSourcePeer('hq');
    const offline = vi.fn(async () => ({ ok: false, status: null, data: null, error: 'timeout' }));
    await expect(resolveVaultEnv('svc', { vault, getPeer: () => peer, fetch: offline, notify })).rejects.toThrow('vault_authorization_unavailable');
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

  it('does not let site overrides bypass a headquarters authorization refusal', async () => {
    const notify = vi.fn();
    await resolveVaultEnv('cernere', { vault, getPeer: () => peer, fetch: hq({ DATABASE_URL: 'postgres://hq' }), notify });
    const refused = async () => ({ ok: false, status: 403, data: null, error: 'HTTP 403' });
    await expect(resolveVaultEnv('cernere', { vault, getPeer: () => peer, fetch: refused, notify })).rejects.toThrow('vault_authorization_revoked');
    expect(await vault.cachedEnv('cernere')).toBeNull();
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
  async function request(granted: boolean, service = 'svc') {
    const pass = async (c: { set: (k: 'federationCaller', v: unknown) => void }, next: () => Promise<void>) => {
      c.set('federationCaller', { peerId: 'branch', peerName: 'kaoimac', claimedNode: null,
        authMode: 'cr-v1', expiresAt: Date.now() + 60_000,
        grants: granted ? [{ action: 'vault', resource: `service:${service}`, keys: ['TOKEN'] }] : [],
      });
      await next();
    };
    await vault.setEntry('TOKEN', 'shared');
    await vault.setEntry('ADMIN_SECRET', 'never-delivered');
    vault.setBindings('svc', ['TOKEN', 'ADMIN_SECRET', 'MISSING_SECRET']);
    const app = buildVaultPublicRoutes({ auth: pass as never, vault: () => vault });
    return app.request('/api/v1/federation/vault/env', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ service }),
    });
  }

  it('delivers only explicitly granted keys and hides other missing keys', async () => {
    const response = await request(true);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ env: { TOKEN: 'shared' }, missing: [] });
  });

  it('refuses a service without a Cr grant', async () => {
    expect((await request(false)).status).toBe(403);
  });

  it('answers not_bound for services without Vault bindings', async () => {
    expect((await request(true, 'other')).status).toBe(404);
  });
});

describe('vault admin API', () => {
  function app() {
    return buildVaultRouter({ vault: () => vault, peerExists: (id) => id === 'hq' });
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

  it('rejects retired import routes without changing Vault entries or bindings', async () => {
    await vault.setEntry('EXISTING', 'keep');
    vault.setBindings('svc', ['EXISTING']);
    for (const path of ['/api/v1/vault/import/infisical', '/api/v1/vault/import/infisical/svc']) {
      expect((await app().request(path, { method: 'POST' })).status).toBe(404);
    }
    expect((await vault.envFor('svc'))?.env).toEqual({ EXISTING: 'keep' });
    expect(vault.bindingsFor('svc')).toEqual(['EXISTING']);
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
