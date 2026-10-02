import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKeyStore } from './keystore.js';
import { Vault } from './vault.js';
import { importAllFromInfisical, type BulkImportDeps } from './infisical-bulk-import.js';
import { buildVaultRouter } from './vault-router.js';
import type { InfisicalProject, InfisicalSecret } from '../secrets/infisical.js';
import type { ServiceInfisical } from '../secrets/config-store.js';

let dir = '';
let vault: Vault;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'excubitor-vault-bulk-'));
  vault = new Vault({ dir, keyStore: createKeyStore(dir, 'linux'), now: () => 1_000 });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const identity = { siteUrl: 'https://infisical.test', clientId: 'id', clientSecret: 'secret' };

function mapping(projectId: string, extra: Partial<ServiceInfisical> = {}): ServiceInfisical {
  return { project_id: projectId, environment: 'dev', inject: true, prefix: '', ...extra };
}

function secrets(values: Record<string, string>): InfisicalSecret[] {
  return Object.entries(values).map(([secretKey, secretValue]) => ({ secretKey, secretValue }));
}

function deps(
  store: Record<string, Record<string, string>>,
  projects: InfisicalProject[],
  services: BulkImportDeps['services'],
): BulkImportDeps {
  return {
    vault,
    identity,
    services,
    listProjects: async () => projects,
    fetchSecrets: vi.fn(async (_id, projectId: string, environment: string) => {
      const values = store[`${projectId}:${environment}`];
      if (!values) throw new Error(`Infisical secrets fetch failed: 404`);
      return secrets(values);
    }),
  };
}

const env = (...slugs: string[]) => slugs.map((slug) => ({ slug, name: slug }));

describe('importAllFromInfisical', () => {
  it('imports mapped services with their mapping and binds them, then imports unmapped projects without binding', async () => {
    const d = deps(
      {
        'p-cernere:dev': { DATABASE_URL: 'pg://c', API_KEY: 'k' },
        'p-cf:dev': { CF_API_TOKEN: 'cf-token', CF_ACCOUNT_ID: 'acct' },
      },
      [
        { id: 'p-cernere', name: 'Cernere', environments: env('dev') },
        { id: 'p-cf', name: 'Cloudflare', environments: env('dev', 'prod') },
      ],
      [{ code: 'cernere', mapping: mapping('p-cernere') }],
    );

    const result = await importAllFromInfisical(d);

    expect(result.dry_run).toBe(false);
    expect(result.services).toEqual([
      { code: 'cernere', project_id: 'p-cernere', environment: 'dev', imported: ['API_KEY', 'DATABASE_URL'], unchanged: [], conflicts: [], invalid: [] },
    ]);
    // サービスに紐付く project は二重に取り込まない。
    expect(result.projects).toEqual([
      { project_id: 'p-cf', name: 'Cloudflare', environment: 'dev', imported: ['CF_ACCOUNT_ID', 'CF_API_TOKEN'], unchanged: [], conflicts: [], invalid: [] },
    ]);
    expect((await vault.envFor('cernere'))?.env).toEqual({ API_KEY: 'k', DATABASE_URL: 'pg://c' });
    expect(await vault.forProject('p-cf').valuesOf(['CF_API_TOKEN', 'CF_ACCOUNT_ID'])).toEqual({ CF_API_TOKEN: 'cf-token', CF_ACCOUNT_ID: 'acct' });
    expect(vault.forProject('p-cernere').status().bindings).toEqual({ cernere: [{ name: 'API_KEY', present: true }, { name: 'DATABASE_URL', present: true }] });
    expect(vault.status().entries).toEqual([]);
  });

  it('applies the service prefix / include filter', async () => {
    const d = deps(
      { 'p1:prod': { TOKEN: 't', SKIP: 's' } },
      [{ id: 'p1', name: 'P1', environments: env('prod') }],
      [{ code: 'svc', mapping: mapping('p1', { environment: 'prod', prefix: 'SVC_', include: ['TOKEN'] }) }],
    );
    const result = await importAllFromInfisical(d);
    expect(result.services[0]).toMatchObject({ environment: 'prod', imported: ['SVC_TOKEN'] });
    expect(vault.forProject('p1').bindingsFor('svc')).toEqual(['SVC_TOKEN']);
  });

  it('dry run classifies without changing the Vault', async () => {
    await vault.setEntry('SHARED', 'old');
    const d = deps(
      { 'p1:dev': { SHARED: 'new', FRESH: 'f' } },
      [{ id: 'p1', name: 'P1', environments: env('dev') }],
      [{ code: 'svc', mapping: mapping('p1') }],
    );
    const result = await importAllFromInfisical(d, { dryRun: true });
    expect(result.dry_run).toBe(true);
    expect(result.services[0]).toMatchObject({ imported: ['FRESH', 'SHARED'], conflicts: [] });
    expect(vault.status().entries.map((e) => e.name)).toEqual(['SHARED']);
    expect(vault.bindingsFor('svc')).toEqual([]);
    expect(vault.status().projects).toEqual([]);
  });

  it('never overwrites a different existing value and leaves conflicts unbound', async () => {
    await vault.setEntry('DATABASE_URL', 'keep');
    vault.registerProject('p1');
    await vault.forProject('p1').setEntry('DATABASE_URL', 'keep-project');
    const d = deps(
      { 'p1:dev': { DATABASE_URL: 'other', NEW_KEY: 'n' } },
      [],
      [{ code: 'svc', mapping: mapping('p1') }],
    );
    const result = await importAllFromInfisical(d);
    expect(result.services[0]).toMatchObject({ imported: ['NEW_KEY'], conflicts: ['DATABASE_URL'] });
    expect(await vault.valuesOf(['DATABASE_URL'])).toEqual({ DATABASE_URL: 'keep' });
    expect(vault.forProject('p1').bindingsFor('svc')).toEqual(['NEW_KEY']);
    expect(await vault.forProject('p1').valuesOf(['DATABASE_URL'])).toEqual({ DATABASE_URL: 'keep-project' });
  });

  it('chooses the environment for unmapped projects and skips ambiguous ones', async () => {
    const d = deps(
      { 'only-prod:prod': { A: 'a' }, 'has-dev:dev': { B: 'b' } },
      [
        { id: 'only-prod', name: 'OnlyProd', environments: env('prod') },
        { id: 'has-dev', name: 'HasDev', environments: env('dev', 'prod') },
        { id: 'ambiguous', name: 'Ambiguous', environments: env('staging', 'prod') },
      ],
      [],
    );
    const result = await importAllFromInfisical(d);
    expect(result.projects.map((p) => [p.name, p.environment, p.imported])).toEqual([
      ['OnlyProd', 'prod', ['A']],
      ['HasDev', 'dev', ['B']],
      ['Ambiguous', null, []],
    ]);
    expect(result.projects[2]!.skipped).toMatch(/staging, prod/);

    const chosen = await importAllFromInfisical(deps({ 'ambiguous:staging': { C: 'c' } }, [{ id: 'ambiguous', name: 'Ambiguous', environments: env('staging', 'prod') }], []), { environment: 'staging' });
    expect(chosen.projects[0]).toMatchObject({ environment: 'staging', imported: ['C'] });
  });

  it('preserves empty values and reports invalid names / per-target failures', async () => {
    const d = deps(
      { 'p1:dev': { 'BAD-NAME': 'x', EMPTY: '', GOOD: 'g' } },
      [{ id: 'p1', name: 'P1', environments: env('dev') }, { id: 'broken', name: 'Broken', environments: env('dev') }],
      [{ code: 'missing', mapping: mapping('gone') }],
    );
    const result = await importAllFromInfisical(d);
    expect(result.services[0]).toMatchObject({ code: 'missing', error: 'Infisical secrets fetch failed: 404', imported: [] });
    expect(result.projects[0]).toMatchObject({ name: 'P1', imported: ['EMPTY', 'GOOD'], invalid: ['BAD-NAME'] });
    expect(result.projects[1]).toMatchObject({ name: 'Broken', error: 'Infisical secrets fetch failed: 404' });
  });

  it('never puts values in the result', async () => {
    const d = deps({ 'p1:dev': { TOKEN: 'super-secret-value' } }, [{ id: 'p1', name: 'P1', environments: env('dev') }], []);
    expect(JSON.stringify(await importAllFromInfisical(d))).not.toContain('super-secret-value');
  });

  it('imports same-named values in separate projects and is idempotent', async () => {
    await vault.setEntry('DATABASE_URL', 'shared');
    const d = deps({ 'a:dev': { DATABASE_URL: 'a-db' }, 'b:dev': { DATABASE_URL: 'b-db' } }, [
      { id: 'a', name: 'A', environments: env('dev') }, { id: 'b', name: 'B', environments: env('dev') },
    ], []);
    const first = await importAllFromInfisical(d);
    expect(first.projects.every((p) => p.conflicts.length === 0 && p.imported.length === 1)).toBe(true);
    expect(await vault.forProject('a').valuesOf(['DATABASE_URL'])).toEqual({ DATABASE_URL: 'a-db' });
    expect(await vault.forProject('b').valuesOf(['DATABASE_URL'])).toEqual({ DATABASE_URL: 'b-db' });
    expect(await vault.valuesOf(['DATABASE_URL'])).toEqual({ DATABASE_URL: 'shared' });
    const second = await importAllFromInfisical(d);
    expect(second.projects.every((p) => p.unchanged.length === 1 && p.imported.length === 0)).toBe(true);
  });
});

describe('POST /api/v1/vault/import/infisical', () => {
  function app(bulkImport: NonNullable<Parameters<typeof buildVaultRouter>[0]['bulkImport']>) {
    return buildVaultRouter({ vault: () => vault, getCatalogInfisical: () => undefined, bulkImport });
  }
  const post = (api: ReturnType<typeof app>, body: unknown) =>
    api.request('/api/v1/vault/import/infisical', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('passes dry_run / environment and returns the result', async () => {
    const bulkImport = vi.fn(async () => ({ dry_run: true, services: [], projects: [] }));
    const response = await post(app(bulkImport), { dry_run: true, environment: 'prod' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, dry_run: true, services: [], projects: [] });
    expect(bulkImport).toHaveBeenCalledWith({ dryRun: true, environment: 'prod' });
  });

  it('answers no_identity when Excubitor has no Infisical machine identity', async () => {
    const response = await post(app(async () => null), {});
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('no_identity');
  });

  it('answers 502 when the project list cannot be read, and 400 for a bad body', async () => {
    const failing = await post(app(async () => { throw new Error('Infisical project list failed: 403'); }), {});
    expect(failing.status).toBe(502);
    const bad = await post(app(async () => null), { dry_run: 'yes' });
    expect(bad.status).toBe(400);
  });
});
