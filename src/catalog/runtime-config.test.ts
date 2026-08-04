import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../shared/roots.js', () => ({
  arsRoot: () => 'D:/Workspace',
  domainRoot: () => '.example.test',
}));

import { readRuntimeConfig } from './runtime-config.js';

const tempDirs: string[] = [];

function writeConfig(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'excubitor-runtime-config-'));
  tempDirs.push(dir);
  const path = join(dir, 'excubitor.config.yaml');
  writeFileSync(path, body, 'utf8');
  return path;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('readRuntimeConfig', () => {
  it('reads Excubitor-only policy and interpolates roots', () => {
    const path = writeConfig([
      'global:',
      '  env:',
      '    LUDIARS_ALLOWED_HOSTS: "${DOMAIN_ROOT}"',
      'retention:',
      '  enabled: true',
      '  logs_hours: 72',
    ].join('\n'));

    expect(readRuntimeConfig(path)).toEqual({
      global: { env: { LUDIARS_ALLOWED_HOSTS: '.example.test' } },
      retention: { enabled: true, logs_hours: 72 },
    });
  });

  it('treats an empty document as empty policy', () => {
    expect(readRuntimeConfig(writeConfig('# only a comment\n'))).toEqual({});
  });

  // service definition の正本は各所有リポの excubitor.catalog.yaml だけ。中央定義の復活を拒む。
  it('rejects a top-level services key', () => {
    const path = writeConfig('services:\n  - code: central\n    name: Central\n    runtime: node\n');
    expect(() => readRuntimeConfig(path)).toThrow(/must not contain services/);
  });

  it('rejects a non-object document', () => {
    expect(() => readRuntimeConfig(writeConfig('- not-an-object\n'))).toThrow(/must be a YAML object/);
  });
});
