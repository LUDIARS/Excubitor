import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { updateServiceCatalogInfo } from './editor.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('updateServiceCatalogInfo', () => {
  it('updates only editable catalog fields inside the target service block', () => {
    const dir = mkdtempSync(join(tmpdir(), 'excubitor-catalog-editor-'));
    tempDirs.push(dir);
    mkdirSync(join(dir, 'catalog'));
    const path = join(dir, 'catalog/services.yaml');
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
});
