import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearFragmentCache } from './fragments.js';
import { loadCatalog, type Service } from './loader.js';

const ENV_KEYS = [
  'EXCUBITOR_ARS_ROOT',
  'EXCUBITOR_AUTO_CATALOG_PATH',
  'EXCUBITOR_FRAGMENT_DIRS',
  'EXCUBITOR_FRAGMENT_SECRET_ALLOWLIST',
] as const;

const savedEnv: Record<string, string | undefined> = {};
const tempDirs: string[] = [];

function makeRepoFragment(root: string, repo: string, body: string): void {
  const dir = join(root, repo);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'excubitor.catalog.yaml'), body, 'utf8');
}

function findByCode(services: Service[], code: string): Service | undefined {
  return services.find((s) => s.code === code);
}

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  clearFragmentCache();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  clearFragmentCache();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('loadCatalog fragment merge priority', () => {
  it('does NOT let a fragment override a base catalog service code (base wins)', () => {
    const root = mkdtempSync(join(tmpdir(), 'excubitor-loader-'));
    tempDirs.push(root);
    process.env.EXCUBITOR_ARS_ROOT = root;
    // auto-catalog を実ファイルから切り離す (テストの hermetic 化)。
    process.env.EXCUBITOR_AUTO_CATALOG_PATH = join(root, 'no-such-auto.yaml');
    // ambient env の混入防止 (追加ルート / secret allowlist を無効化)。
    delete process.env.EXCUBITOR_FRAGMENT_DIRS;
    delete process.env.EXCUBITOR_FRAGMENT_SECRET_ALLOWLIST;

    // 手書き base 正本 (信頼される source)。
    const basePath = join(root, 'base-services.yaml');
    writeFileSync(
      basePath,
      [
        'services:',
        '  - code: shared',
        '    name: Base Shared',
        '    runtime: node',
        '    port: 1111',
        '',
      ].join('\n'),
      'utf8',
    );

    // 断片が同じ code を別定義で「上書き」しようとする + 断片固有 code も持つ。
    makeRepoFragment(
      root,
      'Rogue',
      [
        'services:',
        '  - code: shared',
        '    name: Fragment Override',
        '    runtime: node',
        '    port: 9999',
        '  - code: rogueonly',
        '    name: Rogue Only',
        '    runtime: node',
        '    port: 2222',
        '',
      ].join('\n'),
    );

    const catalog = loadCatalog(basePath);

    // セキュリティ境界: base の code は断片に上書きされない。
    const shared = findByCode(catalog.services, 'shared');
    expect(catalog.services.filter((s) => s.code === 'shared')).toHaveLength(1);
    expect(shared?.name).toBe('Base Shared');
    expect(shared?.port).toBe(1111);

    // 断片は「新しい code」なら正しくマージされる (優先順位の下位として補完)。
    const rogueOnly = findByCode(catalog.services, 'rogueonly');
    expect(rogueOnly?.name).toBe('Rogue Only');
    expect(rogueOnly?.port).toBe(2222);
  });
});
