import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Vault } from '../vault/vault.js';
import { createKeyStore } from '../vault/keystore.js';
import { TerminalProfileStore } from './profile-store.js';
import { credentialNames, removeCredentials, resolveCredentials, saveCredentials } from './credentials.js';
import { importLegacyCredentials } from './legacy-credentials.js';
import type { TerminalProfile } from './schema.js';

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe('terminal persistence', () => {
  it('keeps credentials and their key separate from environment Vault and deletes only this profile', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ex-terminal-')); directories.push(dir);
    const environment = new Vault({ dir, keyStore: createKeyStore(dir, 'linux') });
    await environment.setEntry('SERVICE_SECRET', 'service-password');
    const original = readFileSync(join(dir, 'vault.json'), 'utf8');
    const dedicated = join(dir, 'terminal-credentials');
    const vault = new Vault({ dir: dedicated, keyStore: createKeyStore(dedicated, 'linux') });
    const path = join(dir, 'terminal-connections.json');
    const store = new TerminalProfileStore(path);
    const profile: TerminalProfile = { id: '058c04b4-12d4-4c49-a158-0379bb30d3b3', serverName: 'VPN server',
      host: '100.64.0.10', port: 22, network: 'private', auth: 'password', hostKey: `SHA256:${'A'.repeat(43)}` };
    await saveCredentials(profile.id, { username: 'operator', password: 'private-password' }, vault);
    store.put(profile);
    expect(new TerminalProfileStore(path).get(profile.id)).toEqual(profile);
    expect(readFileSync(path, 'utf8')).not.toContain('private-password');
    expect(readFileSync(join(dedicated, 'vault.json'), 'utf8')).not.toContain('private-password');
    expect(readFileSync(join(dir, 'vault.json'), 'utf8')).toBe(original);
    expect(readFileSync(join(dedicated, 'vault.key'), 'utf8')).not.toBe(readFileSync(join(dir, 'vault.key'), 'utf8'));
    expect(environment.status().entries.map((e) => e.name)).toEqual(['SERVICE_SECRET']);
    expect(environment.status().projects).toEqual([]);
    expect(await resolveCredentials(profile, vault)).toEqual({ username: 'operator', password: 'private-password' });
    // An empty independent store cannot silently read credentials from environment Vault.
    await expect(resolveCredentials(profile, environment)).rejects.toThrow('username_missing');
    await expect(resolveCredentials({ ...profile, auth: 'key' }, vault)).rejects.toThrow('private_key_missing');
    const otherId = '295c513d-9c44-40f2-a544-9f469642e723';
    await saveCredentials(otherId, { username: 'other' }, vault);
    await removeCredentials(profile.id, vault);
    store.remove(profile.id);
    expect(store.list()).toEqual([]);
    expect(await vault.valuesOf(Object.values(credentialNames(profile.id)))).toEqual({});
    expect((await vault.valuesOf([credentialNames(otherId).username]))[credentialNames(otherId).username]).toBe('other');
    expect(readFileSync(join(dir, 'vault.json'), 'utf8')).toBe(original);
  });

  it('imports only the selected legacy profile without overwriting new values or removing originals', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ex-terminal-import-')); directories.push(dir);
    const source = new Vault({ dir, keyStore: createKeyStore(dir, 'linux') });
    const destDir = join(dir, 'terminal-credentials');
    const destination = new Vault({ dir: destDir, keyStore: createKeyStore(destDir, 'linux') });
    const id = '058c04b4-12d4-4c49-a158-0379bb30d3b3';
    await saveCredentials(id, { username: 'legacy-user', password: 'old-secret', passphrase: 'old-passphrase' }, source);
    await source.setEntry('UNRELATED', 'unrelated-secret');
    const original = readFileSync(join(dir, 'vault.json'), 'utf8');
    await saveCredentials(id, { password: 'new-secret', passphrase: '' }, destination);
    expect(await importLegacyCredentials(id, destination, source)).toEqual({ imported: 1, preserved: 2 });
    expect(await importLegacyCredentials(id, destination, source)).toEqual({ imported: 0, preserved: 3 });
    const values = await destination.valuesOf(Object.values(credentialNames(id)));
    expect(values[credentialNames(id).username]).toBe('legacy-user');
    expect(values[credentialNames(id).password]).toBe('new-secret');
    expect(values[credentialNames(id).passphrase]).toBe('');
    expect(await destination.valuesOf(['UNRELATED'])).toEqual({});
    expect(readFileSync(join(dir, 'vault.json'), 'utf8')).toBe(original);
    writeFileSync(join(destDir, 'vault.json'), 'corrupted', 'utf8');
    await expect(importLegacyCredentials(id, destination, source)).rejects.toThrow();
  });

  it('preserves a newer edit submitted while legacy import is waiting', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ex-terminal-concurrent-')); directories.push(dir);
    const source = new Vault({ dir, keyStore: createKeyStore(dir, 'linux') });
    const destDir = join(dir, 'terminal-credentials');
    const destination = new Vault({ dir: destDir, keyStore: createKeyStore(destDir, 'linux') });
    const id = '058c04b4-12d4-4c49-a158-0379bb30d3b3';
    const name = credentialNames(id).password;
    let markReadStarted: () => void = () => { throw new Error('read start not observed'); };
    const readStarted = new Promise<void>((resolve) => { markReadStarted = resolve; });
    let release: (values: Record<string, string>) => void = () => { throw new Error('read not started'); };
    const pendingRead = new Promise<Record<string, string>>((resolve) => { release = resolve; });
    vi.spyOn(source, 'valuesOf').mockImplementation(() => {
      markReadStarted();
      return pendingRead;
    });
    const importing = importLegacyCredentials(id, destination, source);
    await readStarted;
    const saving = saveCredentials(id, { password: 'newer-password' }, destination);
    release({ [name]: 'legacy-password' });
    await Promise.all([importing, saving]);
    expect(await destination.valuesOf([name])).toEqual({ [name]: 'newer-password' });
  });
});
