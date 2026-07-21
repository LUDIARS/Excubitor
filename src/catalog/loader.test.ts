import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadCatalog } from './loader.js';
import { clearFragmentCache } from './fragments.js';

const originalArsRoot = process.env.EXCUBITOR_ARS_ROOT;
const originalAutoPath = process.env.EXCUBITOR_AUTO_CATALOG_PATH;
const tempDirs: string[] = [];

function makeRepoFragment(root: string, repo: string, body: string): void {
  const repoDir = join(root, repo);
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(join(repoDir, 'excubitor.catalog.yaml'), body, 'utf8');
}

function writeBase(dir: string, body: string): string {
  const path = join(dir, 'services.yaml');
  writeFileSync(path, body, 'utf8');
  return path;
}

beforeEach(() => {
  clearFragmentCache();
  // auto-catalog を確実に空にする (テストの独立性)。
  process.env.EXCUBITOR_AUTO_CATALOG_PATH = join(
    mkdtempSync(join(tmpdir(), 'excubitor-auto-')),
    'nonexistent.auto.yaml',
  );
});

afterEach(() => {
  if (originalArsRoot === undefined) delete process.env.EXCUBITOR_ARS_ROOT;
  else process.env.EXCUBITOR_ARS_ROOT = originalArsRoot;
  if (originalAutoPath === undefined) delete process.env.EXCUBITOR_AUTO_CATALOG_PATH;
  else process.env.EXCUBITOR_AUTO_CATALOG_PATH = originalAutoPath;
  clearFragmentCache();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('loadCatalog merge precedence (security boundary)', () => {
  it('a fragment cannot override a base service with the same code', () => {
    const root = mkdtempSync(join(tmpdir(), 'excubitor-loader-'));
    tempDirs.push(root);
    process.env.EXCUBITOR_ARS_ROOT = root;

    // 攻撃側: 断片が base と同じ code (shared) を、 別の (悪意ある) 定義で宣言する。
    makeRepoFragment(
      root,
      'Rogue',
      'services:\n' +
        '  - code: shared\n' +
        '    name: FromFragment\n' +
        '    runtime: node\n' +
        '    command: rogue-command\n' +
        '  - code: extra\n' +
        '    name: ExtraFragment\n' +
        '    runtime: node\n',
    );

    const baseDir = mkdtempSync(join(tmpdir(), 'excubitor-base-'));
    tempDirs.push(baseDir);
    const basePath = writeBase(
      baseDir,
      'services:\n' +
        '  - code: shared\n' +
        '    name: FromBase\n' +
        '    runtime: node\n' +
        '    command: base-command\n',
    );

    const catalog = loadCatalog(basePath);

    const shared = catalog.services.find((s) => s.code === 'shared');
    expect(shared?.name).toBe('FromBase'); // base が勝つ — 断片は上書きできない
    expect(shared?.command).toBe('base-command');

    // 衝突しない断片エントリは通常どおり寄与する。
    const extra = catalog.services.find((s) => s.code === 'extra');
    expect(extra?.name).toBe('ExtraFragment');
  });

  it('drops schema-invalid fragment entries while keeping valid ones', () => {
    const root = mkdtempSync(join(tmpdir(), 'excubitor-loader-'));
    tempDirs.push(root);
    process.env.EXCUBITOR_ARS_ROOT = root;

    makeRepoFragment(
      root,
      'Mixed',
      'services:\n' +
        '  - code: good\n' +
        '    name: Good\n' +
        '    runtime: node\n' +
        '  - code: bad\n' +
        '    name: Bad\n' +
        '    runtime: not-a-real-runtime\n', // enum 不一致 = schema invalid
    );

    const baseDir = mkdtempSync(join(tmpdir(), 'excubitor-base-'));
    tempDirs.push(baseDir);
    const basePath = writeBase(baseDir, 'services: []\n');

    const catalog = loadCatalog(basePath);
    expect(catalog.services.find((s) => s.code === 'good')).toBeDefined();
    expect(catalog.services.find((s) => s.code === 'bad')).toBeUndefined();
  });
});
