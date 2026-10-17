import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalProfileStore } from './profile-store.js';
import { buildTerminalRouter } from './router.js';
import { Vault } from '../vault/vault.js';
import { createKeyStore } from '../vault/keystore.js';
import { saveCredentials, credentialNames } from './credentials.js';
import type { TerminalProfile } from './schema.js';

vi.mock('./transport.js', () => ({ executeTerminalCommand: vi.fn(), inspectHostKey: vi.fn() }));
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function router() {
  const dir = mkdtempSync(join(tmpdir(), 'ex-terminal-router-')); directories.push(dir);
  return buildTerminalRouter(new TerminalProfileStore(join(dir, 'profiles.json')),
    new Vault({ dir: join(dir, 'credentials'), keyStore: createKeyStore(join(dir, 'credentials'), 'linux') }),
    () => new Vault({ dir, keyStore: createKeyStore(dir, 'linux') }));
}
describe('terminal local HTTP boundary', () => {
  it('rejects requests without the custom header, and cross-origin or externally addressed requests', async () => {
    const app = router();
    expect((await app.request('http://127.0.0.1/api/v1/terminal/profiles')).status).toBe(403);
    expect((await app.request('http://127.0.0.1/api/v1/terminal/profiles', { headers: { 'x-excubitor-terminal': '1', origin: 'https://evil.example' } })).status).toBe(403);
    expect((await app.request('https://public.example/api/v1/terminal/profiles', { headers: { 'x-excubitor-terminal': '1' } })).status).toBe(403);
    const allowed = await app.request('http://127.0.0.1/api/v1/terminal/profiles', { headers: { 'x-excubitor-terminal': '1' } });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('cache-control')).toBe('no-store');
  });
  it('rejects external password profiles even when the client bypasses the UI', async () => {
    const id = '058c04b4-12d4-4c49-a158-0379bb30d3b3';
    const response = await router().request(`http://127.0.0.1/api/v1/terminal/profiles/${id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json', 'x-excubitor-terminal': '1' },
      body: JSON.stringify({ profile: { id, serverName: 'external', host: '8.8.8.8', port: 22, network: 'external', auth: 'password', hostKey: `SHA256:${'A'.repeat(43)}` } }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_profile' });
  });
  it('does not access legacy Vault until explicit import and deletes dedicated secrets only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ex-terminal-migrate-')); directories.push(dir);
    const source = new Vault({ dir, keyStore: createKeyStore(dir, 'linux') });
    const dedicated = join(dir, 'credentials');
    const destination = new Vault({ dir: dedicated, keyStore: createKeyStore(dedicated, 'linux') });
    const store = new TerminalProfileStore(join(dir, 'profiles.json'));
    const profile: TerminalProfile = { id: '058c04b4-12d4-4c49-a158-0379bb30d3b3', serverName: 'test', host: 'server.example.com',
      port: 22, network: 'private', auth: 'password', hostKey: `SHA256:${'A'.repeat(43)}` };
    store.put(profile);
    await saveCredentials(profile.id, { username: 'operator', password: 'secret-marker' }, source);
    const legacy = vi.fn(() => source);
    const app = buildTerminalRouter(store, destination, legacy);
    const base = 'http://127.0.0.1/api/v1/terminal/profiles';
    const headers = { 'x-excubitor-terminal': '1' };
    const listed = await (await app.request(base, { headers })).text();
    expect(legacy).not.toHaveBeenCalled();
    expect(listed).not.toContain('secret-marker');
    expect(listed).not.toContain('credentialNames');
    expect(destination.status().entries).toEqual([]);
    const denied = await app.request(`${base}/${profile.id}/import-vault`, { method: 'POST' });
    expect(denied.status).toBe(403);
    expect(legacy).not.toHaveBeenCalled();
    const imported = await app.request(`${base}/${profile.id}/import-vault`, { method: 'POST', headers });
    expect(await imported.json()).toEqual({ imported: 2, preserved: 0 });
    expect(legacy).toHaveBeenCalledTimes(1);
    expect((await app.request(`${base}/${profile.id}`, { method: 'DELETE', headers })).status).toBe(200);
    expect(destination.status().entries).toEqual([]);
    expect((await source.valuesOf([credentialNames(profile.id).password]))[credentialNames(profile.id).password]).toBe('secret-marker');
    expect(store.list()).toEqual([]);
  });
});
