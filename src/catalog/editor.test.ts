import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { updateServiceCatalogInfo } from './editor.js';
import { clearFragmentCache } from './fragments.js';

const tempDirs: string[] = [];
const envKeys = ['EXCUBITOR_ARS_ROOT', 'EXCUBITOR_TRUSTED_FRAGMENT_REPOS'] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of envKeys) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  clearFragmentCache();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('updateServiceCatalogInfo', () => {
  it('updates only editable catalog fields inside the target service block', () => {
    const dir = mkdtempSync(join(tmpdir(), 'excubitor-catalog-editor-'));
    tempDirs.push(dir);
    const path = join(dir, 'excubitor.catalog.yaml');
    writeFileSync(path, [
      '# keep this comment',
      'services:',
      '  - code: alpha',
      '    name: Alpha',
      '    project_code: old',
      '    runtime: node',
      '  - code: beta',
      '    name: Beta',
      '    runtime: node',
      '',
    ].join('\n'), 'utf8');

    updateServiceCatalogInfo('alpha', {
      project_code: 'new',
      subdomain: 'alpha-web',
      frontend_url: null,
      domain: 'alpha-web${DOMAIN_ROOT}',
    }, path);

    const updated = readFileSync(path, 'utf8');
    expect(updated).toContain('# keep this comment');
    expect(updated).toContain('    project_code: new');
    expect(updated).toContain('    subdomain: alpha-web');
    expect(updated).not.toContain('frontend_url:');
    expect(updated).toContain('    domain: alpha-web${DOMAIN_ROOT}');
    expect(updated).toContain('  - code: beta\n    name: Beta');
  });

  // path を渡さない本番経路は、その service を所有する信頼済みリポの catalog を書き換える。
  it('writes into the owning repository catalog when no path is given', () => {
    const root = mkdtempSync(join(tmpdir(), 'excubitor-catalog-owner-'));
    tempDirs.push(root);
    process.env.EXCUBITOR_ARS_ROOT = root;
    process.env.EXCUBITOR_TRUSTED_FRAGMENT_REPOS = 'Owner';
    clearFragmentCache();

    mkdirSync(join(root, 'Owner'), { recursive: true });
    const owned = join(root, 'Owner', 'excubitor.catalog.yaml');
    writeFileSync(owned, [
      'services:',
      '  - code: owned',
      '    name: Owned',
      '    runtime: node',
      '',
    ].join('\n'), 'utf8');

    updateServiceCatalogInfo('owned', { project_code: 'owned-project' });

    expect(readFileSync(owned, 'utf8')).toContain('    project_code: owned-project');
  });

  it('refuses to edit a service without a trusted owning catalog', () => {
    const root = mkdtempSync(join(tmpdir(), 'excubitor-catalog-owner-missing-'));
    tempDirs.push(root);
    process.env.EXCUBITOR_ARS_ROOT = root;
    delete process.env.EXCUBITOR_TRUSTED_FRAGMENT_REPOS;
    clearFragmentCache();

    expect(() => updateServiceCatalogInfo('absent', { project_code: 'x' }))
      .toThrow(/service-owned catalog not found: absent/);
  });
});
