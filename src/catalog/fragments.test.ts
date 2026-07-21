import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearFragmentCache, fragmentFiles, readFragmentServicesRaw } from './fragments.js';

const originalArsRoot = process.env.EXCUBITOR_ARS_ROOT;
const tempDirs: string[] = [];

function makeRepoFragment(root: string, repo: string, body: string): string {
  const repoDir = join(root, repo);
  mkdirSync(repoDir, { recursive: true });
  const path = join(repoDir, 'excubitor.catalog.yaml');
  writeFileSync(path, body, 'utf8');
  return path;
}

beforeEach(() => {
  clearFragmentCache();
});

afterEach(() => {
  if (originalArsRoot === undefined) delete process.env.EXCUBITOR_ARS_ROOT;
  else process.env.EXCUBITOR_ARS_ROOT = originalArsRoot;
  clearFragmentCache();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('catalog fragments', () => {
  it('discovers and aggregates per-repo fragments under ARS_ROOT', () => {
    const root = mkdtempSync(join(tmpdir(), 'excubitor-frag-'));
    tempDirs.push(root);
    process.env.EXCUBITOR_ARS_ROOT = root;

    makeRepoFragment(root, 'Foo', 'services:\n  - code: foo\n    name: Foo\n    runtime: node\n');
    makeRepoFragment(root, 'Bar', 'services:\n  - code: bar\n    name: Bar\n    runtime: node\n');
    // fragment を持たないリポは無視される
    mkdirSync(join(root, 'NoFragment'), { recursive: true });

    const files = fragmentFiles();
    expect(files).toHaveLength(2);

    const agg = readFragmentServicesRaw();
    const codes = agg.services.map((s) => (s as { code: string }).code).sort();
    expect(codes).toEqual(['bar', 'foo']);
    expect(agg.sources).toHaveLength(2);
  });

  it('interpolates ${ARS_ROOT} inside fragment values', () => {
    const root = mkdtempSync(join(tmpdir(), 'excubitor-frag-'));
    tempDirs.push(root);
    process.env.EXCUBITOR_ARS_ROOT = root;

    makeRepoFragment(root, 'Baz', 'services:\n  - code: baz\n    name: Baz\n    runtime: node\n    cwd: ${ARS_ROOT}/Baz\n');

    const svc = readFragmentServicesRaw().services[0] as { cwd: string };
    expect(svc.cwd).toBe(`${root.replace(/\\/g, '/')}/Baz`);
  });

  it('caches aggregation until files change, and clearFragmentCache resets', () => {
    const root = mkdtempSync(join(tmpdir(), 'excubitor-frag-'));
    tempDirs.push(root);
    process.env.EXCUBITOR_ARS_ROOT = root;
    makeRepoFragment(root, 'Foo', 'services:\n  - code: foo\n    name: Foo\n    runtime: node\n');

    const first = readFragmentServicesRaw();
    const second = readFragmentServicesRaw();
    expect(second).toBe(first); // 同一 mtime → 同一オブジェクト (キャッシュ命中)

    clearFragmentCache();
    const third = readFragmentServicesRaw();
    expect(third).not.toBe(first); // キャッシュ破棄後は再集積
    expect(third.services).toHaveLength(1);
  });

  it('survives a single broken fragment without dropping the rest', () => {
    const root = mkdtempSync(join(tmpdir(), 'excubitor-frag-'));
    tempDirs.push(root);
    process.env.EXCUBITOR_ARS_ROOT = root;
    makeRepoFragment(root, 'Good', 'services:\n  - code: good\n    name: Good\n    runtime: node\n');
    makeRepoFragment(root, 'Broken', 'services: [ this is : not : valid yaml\n');

    const aggregate = readFragmentServicesRaw();
    const codes = aggregate.services.map((s) => (s as { code: string }).code);
    expect(codes).toEqual(['good']);
    expect(aggregate.issues).toEqual([
      expect.objectContaining({ kind: 'yaml-parse', retained: false }),
    ]);
  });

  it('retains the last-known-good services while a fragment is temporarily broken', () => {
    const root = mkdtempSync(join(tmpdir(), 'excubitor-frag-'));
    tempDirs.push(root);
    process.env.EXCUBITOR_ARS_ROOT = root;
    const path = makeRepoFragment(root, 'Stable', 'services:\n  - code: stable\n    name: Stable\n    runtime: node\n');

    expect(readFragmentServicesRaw().services).toHaveLength(1);
    writeFileSync(path, 'services: [ temporarily : broken : yaml\n', 'utf8');

    const aggregate = readFragmentServicesRaw();
    expect(aggregate.services).toEqual([
      expect.objectContaining({ code: 'stable' }),
    ]);
    expect(aggregate.issues).toEqual([
      expect.objectContaining({ kind: 'yaml-parse', source: path.replace(/\\/g, '/'), retained: true }),
    ]);
  });

  it('retains the last-known-good services while the discovery root is temporarily unavailable', () => {
    const root = mkdtempSync(join(tmpdir(), 'excubitor-frag-'));
    tempDirs.push(root);
    process.env.EXCUBITOR_ARS_ROOT = root;
    makeRepoFragment(root, 'Stable', 'services:\n  - code: stable\n    name: Stable\n    runtime: node\n');
    expect(readFragmentServicesRaw().services).toHaveLength(1);

    rmSync(root, { recursive: true, force: true });
    const aggregate = readFragmentServicesRaw();

    expect(aggregate.services).toEqual([expect.objectContaining({ code: 'stable' })]);
    expect(aggregate.issues).toEqual([
      expect.objectContaining({ kind: 'root-read', source: root.replace(/\\/g, '/'), retained: true }),
    ]);
  });

  it('invalidates the cache by content hash even when mtime is preserved', () => {
    const root = mkdtempSync(join(tmpdir(), 'excubitor-frag-'));
    tempDirs.push(root);
    process.env.EXCUBITOR_ARS_ROOT = root;
    const path = makeRepoFragment(root, 'Hash', 'services:\n  - code: foo\n    name: Foo\n    runtime: node\n');
    const fixedTime = new Date('2026-07-19T00:00:00.000Z');
    utimesSync(path, fixedTime, fixedTime);

    expect((readFragmentServicesRaw().services[0] as { code: string }).code).toBe('foo');
    writeFileSync(path, 'services:\n  - code: bar\n    name: Bar\n    runtime: node\n', 'utf8');
    utimesSync(path, fixedTime, fixedTime);
    expect(statSync(path).mtimeMs).toBe(fixedTime.getTime());

    expect((readFragmentServicesRaw().services[0] as { code: string }).code).toBe('bar');
  });
});
