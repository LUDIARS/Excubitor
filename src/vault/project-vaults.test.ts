import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createKeyStore } from './keystore.js';
import { ProjectVaults } from './project-vaults.js';
import { Vault } from './vault.js';
import { buildVaultRouter } from './vault-router.js';

let dir: string;
let vault: Vault;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ex-project-vault-'));
  vault = new Vault({ dir, keyStore: createKeyStore(dir, 'linux') });
  vault.registerProject('a', 'Project A');
  vault.registerProject('b', 'Project B');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('project and shared Vaults', () => {
  it('combines explicitly bound shared values with only the service project, which wins by name', async () => {
    await vault.setEntry('DATABASE_URL', 'shared-db');
    await vault.setEntry('COMMON', 'common-value');
    await vault.setEntry('UNBOUND', 'never-inject');
    await vault.forProject('a').setEntry('DATABASE_URL', 'a-db');
    await vault.forProject('b').setEntry('DATABASE_URL', 'b-db');
    vault.setBindings('svc-a', ['DATABASE_URL', 'COMMON']);
    vault.setProjectBindings('a', 'svc-a', ['DATABASE_URL']);
    vault.setProjectBindings('b', 'svc-b', ['DATABASE_URL']);
    expect(await vault.envFor('svc-a')).toEqual({ env: { DATABASE_URL: 'a-db', COMMON: 'common-value' }, missing: [] });
    expect(await vault.envFor('svc-b')).toEqual({ env: { DATABASE_URL: 'b-db' }, missing: [] });
    expect(await vault.envFor('unbound')).toBeNull();
    expect(() => vault.setProjectBindings('b', 'svc-a', ['DATABASE_URL'])).toThrow(/another project/);
    const restarted = new Vault({ dir, keyStore: createKeyStore(dir, 'linux') });
    expect((await restarted.envFor('svc-a'))?.env.DATABASE_URL).toBe('a-db');
  });

  it('reports a missing project credential instead of using a shared credential, and preserves empty strings', async () => {
    await vault.setEntry('TOKEN', 'shared-token');
    vault.setBindings('svc', ['TOKEN']);
    vault.setProjectBindings('a', 'svc', ['TOKEN']);
    expect(await vault.envFor('svc')).toEqual({ env: {}, missing: ['TOKEN'] });
    await vault.forProject('a').setEntry('TOKEN', '');
    expect(await vault.envFor('svc')).toEqual({ env: { TOKEN: '' }, missing: [] });
    vault.setProjectBindings('a', 'svc', []);
    expect((await vault.envFor('svc'))?.env.TOKEN).toBe('shared-token');
  });

  it('authenticates the project identity as well as the variable name', async () => {
    await vault.forProject('a').setEntry('TOKEN', 'a-private-token');
    const inventory = new ProjectVaults(dir);
    const a = JSON.parse(readFileSync(join(inventory.directory('a'), 'vault.json'), 'utf8'));
    await vault.forProject('b').setEntry('TOKEN', 'b-private-token');
    const bPath = join(inventory.directory('b'), 'vault.json');
    const b = JSON.parse(readFileSync(bPath, 'utf8'));
    b.entries.TOKEN = a.entries.TOKEN;
    writeFileSync(bPath, JSON.stringify(b), 'utf8');
    await expect(vault.forProject('b').valuesOf(['TOKEN'])).rejects.toThrow();
    expect(readFileSync(join(inventory.directory('a'), 'vault.json'), 'utf8')).not.toContain('a-private-token');
    expect(JSON.stringify(vault.status())).not.toContain('a-private-token');
  });

  it('retains shared data while editing and deleting project entries via the API', async () => {
    const app = buildVaultRouter({ vault: () => vault, getCatalogInfisical: () => undefined });
    await vault.setEntry('TOKEN', 'shared');
    const put = (project: string) => app.request(`/api/v1/vault/entries/TOKEN?project=${project}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'private' }),
    });
    expect((await put('unknown')).status).toBe(400);
    expect((await put('a')).status).toBe(200);
    expect(await vault.valuesOf(['TOKEN'])).toEqual({ TOKEN: 'shared' });
    expect(await vault.forProject('a').valuesOf(['TOKEN'])).toEqual({ TOKEN: 'private' });
    const status = await app.request('/api/v1/vault');
    expect(await status.text()).not.toContain('private');
    expect((await app.request('/api/v1/vault/entries/TOKEN?project=a', { method: 'DELETE' })).status).toBe(200);
    expect(await vault.forProject('a').valuesOf(['TOKEN'])).toEqual({});
    expect(await vault.valuesOf(['TOKEN'])).toEqual({ TOKEN: 'shared' });
  });
});
