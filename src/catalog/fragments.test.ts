import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearFragmentCache, fragmentFiles, readFragmentServicesRaw } from './fragments.js';

const originalArsRoot = process.env.EXCUBITOR_ARS_ROOT;
const originalSecretAllowlist = process.env.EXCUBITOR_FRAGMENT_SECRET_ALLOWLIST;
const tempDirs: string[] = [];

function fragmentPath(root: string, repo: string): string {
  return join(root, repo, 'excubitor.catalog.yaml');
}

function makeRepoFragment(root: string, repo: string, body: string): void {
  const repoDir = join(root, repo);
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(fragmentPath(root, repo), body, 'utf8');
}

function codesOf(): string[] {
  return readFragmentServicesRaw()
    .services.map((s) => (s as { code: string }).code)
    .sort();
}

beforeEach(() => {
  clearFragmentCache();
});

afterEach(() => {
  if (originalArsRoot === undefined) delete process.env.EXCUBITOR_ARS_ROOT;
  else process.env.EXCUBITOR_ARS_ROOT = originalArsRoot;
  if (originalSecretAllowlist === undefined) delete process.env.EXCUBITOR_FRAGMENT_SECRET_ALLOWLIST;
  else process.env.EXCUBITOR_FRAGMENT_SECRET_ALLOWLIST = originalSecretAllowlist;
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

    const codes = readFragmentServicesRaw().services.map((s) => (s as { code: string }).code);
    expect(codes).toEqual(['good']);
  });

  // finding #1: transient read/parse failure は「サービス削除」ではなく last-known-good を保持する。
  it('retains last-known-good when a previously valid fragment turns transiently broken', () => {
    const root = mkdtempSync(join(tmpdir(), 'excubitor-frag-'));
    tempDirs.push(root);
    process.env.EXCUBITOR_ARS_ROOT = root;
    makeRepoFragment(root, 'Good', 'services:\n  - code: good\n    name: Good\n    runtime: node\n');
    makeRepoFragment(root, 'Flaky', 'services:\n  - code: flaky\n    name: Flaky\n    runtime: node\n');

    expect(codesOf()).toEqual(['flaky', 'good']);

    // Flaky を書き込み途中の壊れた YAML に差し替える (= transient)。
    writeFileSync(fragmentPath(root, 'Flaky'), 'services: [ half-written : : :\n', 'utf8');

    // flaky は消えず、 直近 good が保持される。
    expect(codesOf()).toEqual(['flaky', 'good']);
  });

  // finding #1: 断片ファイルが実際に消えた (ENOENT) ときは genuine 削除として扱う。
  it('drops a fragment only when the file genuinely disappears', () => {
    const root = mkdtempSync(join(tmpdir(), 'excubitor-frag-'));
    tempDirs.push(root);
    process.env.EXCUBITOR_ARS_ROOT = root;
    makeRepoFragment(root, 'Good', 'services:\n  - code: good\n    name: Good\n    runtime: node\n');
    makeRepoFragment(root, 'Gone', 'services:\n  - code: gone\n    name: Gone\n    runtime: node\n');
    expect(codesOf()).toEqual(['gone', 'good']);

    rmSync(join(root, 'Gone'), { recursive: true, force: true });
    expect(codesOf()).toEqual(['good']);
  });

  // finding #8: mtime を据え置いたまま内容だけ変わっても取りこぼさない (内容ハッシュ判定)。
  it('detects content changes even when mtime is unchanged', () => {
    const root = mkdtempSync(join(tmpdir(), 'excubitor-frag-'));
    tempDirs.push(root);
    process.env.EXCUBITOR_ARS_ROOT = root;
    const file = fragmentPath(root, 'Foo');
    makeRepoFragment(root, 'Foo', 'services:\n  - code: foo\n    name: Alpha\n    runtime: node\n');

    expect((readFragmentServicesRaw().services[0] as { name: string }).name).toBe('Alpha');

    const st = statSync(file);
    // 内容を変えつつ mtime を元へ戻す (mtime 依存キャッシュの盲点を再現)。
    writeFileSync(file, 'services:\n  - code: foo\n    name: Beta\n    runtime: node\n', 'utf8');
    utimesSync(file, st.atime, st.mtime);

    expect((readFragmentServicesRaw().services[0] as { name: string }).name).toBe('Beta');
  });

  // finding #2: secret 系宣言の trust 境界。 allowlist 未設定=非破壊 (warn のみ)、
  // 設定すると enforce モードになり allowlist 外リポからは剥がす、 載っていれば通す。
  it('governs secret-bearing fields: warn-only by default, enforce (strip) when allowlist is set', () => {
    const root = mkdtempSync(join(tmpdir(), 'excubitor-frag-'));
    tempDirs.push(root);
    process.env.EXCUBITOR_ARS_ROOT = root;
    makeRepoFragment(
      root,
      'Secretive',
      'services:\n  - code: sec\n    name: Sec\n    runtime: node\n    infisical:\n      project_id: pid\n      environment: dev\n',
    );

    // 未設定: 非破壊で保持 (warn のみ)。
    delete process.env.EXCUBITOR_FRAGMENT_SECRET_ALLOWLIST;
    clearFragmentCache();
    const kept = readFragmentServicesRaw().services[0] as Record<string, unknown>;
    expect(kept.code).toBe('sec');
    expect(kept.infisical).toEqual({ project_id: 'pid', environment: 'dev' });

    // enforce モード + allowlist 外: 剥がす。
    process.env.EXCUBITOR_FRAGMENT_SECRET_ALLOWLIST = 'OtherRepo';
    clearFragmentCache();
    const stripped = readFragmentServicesRaw().services[0] as Record<string, unknown>;
    expect(stripped.code).toBe('sec');
    expect(stripped.infisical).toBeUndefined();

    // enforce モード + allowlist 内: 通す。
    process.env.EXCUBITOR_FRAGMENT_SECRET_ALLOWLIST = 'Secretive';
    clearFragmentCache();
    const allowed = readFragmentServicesRaw().services[0] as Record<string, unknown>;
    expect(allowed.infisical).toEqual({ project_id: 'pid', environment: 'dev' });
  });
});
