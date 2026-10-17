import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { Vault } from '../vault/vault.js';
import { createKeyStore } from '../vault/keystore.js';
import { TerminalProfileStore } from './profile-store.js';
import { credentialNames, resolveCredentials, saveCredentials } from './credentials.js';
import type { TerminalProfile } from './schema.js';

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe('terminal persistence', () => {
  it('keeps credentials encrypted and preserves them when removing a profile', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ex-terminal-')); directories.push(dir);
    const vault = new Vault({ dir, keyStore: createKeyStore(dir, 'linux') });
    const path = join(dir, 'terminal-connections.json');
    const store = new TerminalProfileStore(path);
    const profile: TerminalProfile = { id: '058c04b4-12d4-4c49-a158-0379bb30d3b3', serverName: 'VPN server',
      host: '100.64.0.10', port: 22, network: 'private', auth: 'password', hostKey: `SHA256:${'A'.repeat(43)}` };
    await saveCredentials(profile.id, { username: 'operator', password: 'private-password' }, vault);
    store.put(profile);
    expect(new TerminalProfileStore(path).get(profile.id)).toEqual(profile);
    expect(readFileSync(path, 'utf8')).not.toContain('private-password');
    expect(readFileSync(join(dir, 'vault.json'), 'utf8')).not.toContain('private-password');
    expect(await resolveCredentials(profile, vault)).toEqual({ username: 'operator', password: 'private-password' });
    await expect(resolveCredentials({ ...profile, auth: 'key' }, vault)).rejects.toThrow('private_key_missing');
    store.remove(profile.id);
    expect(store.list()).toEqual([]);
    expect((await vault.valuesOf([credentialNames(profile.id).password]))[credentialNames(profile.id).password]).toBe('private-password');
  });
});
