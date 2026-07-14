import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRelease } from './orchestrator.js';
import { parseReleaseManifest } from './manifest.js';
import type { StepRunner } from './steps.js';

let work: string;
let appRepo: string;
let toolRepo: string;
let outRoot: string;

/** fake runner: build 系は ok、 prod install は node_modules を作って ok。 */
const fakeRunner: StepRunner = async (cmd, cwd) => {
  if (cmd.startsWith('npm ci --omit=dev')) {
    mkdirSync(join(cwd, 'node_modules'), { recursive: true });
    writeFileSync(join(cwd, 'node_modules', '.marker'), 'installed');
  }
  return { ok: true, code: 0, stdout: '', stderr: '' };
};

function makeRepo(dir: string, version: string) {
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'dist', 'index.js'), 'console.log("hi");');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: dir, version }));
  writeFileSync(join(dir, 'package-lock.json'), '{}');
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'excubitor-release-'));
  appRepo = join(work, 'AppRepo');
  toolRepo = join(work, 'ToolRepo');
  outRoot = join(work, 'out');
  makeRepo(appRepo, '9.9.9');
  makeRepo(toolRepo, '0.1.0');
  mkdirSync(join(toolRepo, 'bin'), { recursive: true });
  writeFileSync(join(toolRepo, 'bin', 'tool.mjs'), '#!/usr/bin/env node\n');
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

function manifest() {
  return parseReleaseManifest({
    name: 'demo-allinone',
    display_name: 'Demo AIO',
    primary: 'app',
    output_dir: outRoot,
    components: [
      { code: 'app', role: 'primary', path: appRepo, build: ['npm run build'] },
      {
        code: 'tool',
        role: 'cli',
        path: toolRepo,
        build: ['npm run build'],
        include: ['dist', 'bin', 'package.json', 'package-lock.json'],
        bin_name: 'tool',
        bin_entry: 'bin/tool.mjs',
      },
    ],
  });
}

describe('buildRelease', () => {
  it('自己完結バンドルを組み立てる (version は primary package.json 由来)', async () => {
    const r = await buildRelease(manifest(), {
      catalog: null,
      runner: fakeRunner,
      skipArchive: true,
      builtAt: '2026-06-10T00:00:00.000Z',
    });

    expect(r.ok).toBe(true);
    expect(r.version).toBe('9.9.9');
    const bundle = r.bundleDir!;
    expect(bundle.endsWith(`demo-allinone-9.9.9`)).toBe(true);

    // primary は app/、 cli は packages/<code>/
    expect(existsSync(join(bundle, 'app', 'dist', 'index.js'))).toBe(true);
    expect(existsSync(join(bundle, 'app', 'node_modules', '.marker'))).toBe(true);
    expect(existsSync(join(bundle, 'packages', 'tool', 'bin', 'tool.mjs'))).toBe(true);

    // launcher + shim
    expect(existsSync(join(bundle, 'start.bat'))).toBe(true);
    expect(existsSync(join(bundle, 'start.sh'))).toBe(true);
    expect(existsSync(join(bundle, 'bin', 'tool.cmd'))).toBe(true);
    expect(existsSync(join(bundle, 'bin', 'tool'))).toBe(true);

    // VERSION.json
    const ver = JSON.parse(readFileSync(join(bundle, 'VERSION.json'), 'utf8'));
    expect(ver.name).toBe('demo-allinone');
    expect(ver.version).toBe('9.9.9');
    expect(ver.built_at).toBe('2026-06-10T00:00:00.000Z');
    expect(ver.components.map((c: { code: string }) => c.code).sort()).toEqual(['app', 'tool']);
  });

  it('version オプションが優先される', async () => {
    const r = await buildRelease(manifest(), {
      catalog: null,
      runner: fakeRunner,
      skipArchive: true,
      version: '2.0.0-rc1',
    });
    expect(r.version).toBe('2.0.0-rc1');
    expect(r.bundleDir!.endsWith('demo-allinone-2.0.0-rc1')).toBe(true);
  });

  it('skipInstall で prod install を走らせない', async () => {
    const r = await buildRelease(manifest(), {
      catalog: null,
      runner: fakeRunner,
      skipArchive: true,
      skipInstall: true,
    });
    expect(existsSync(join(r.bundleDir!, 'app', 'node_modules'))).toBe(false);
    expect(r.assemble.every((a) => a.prodInstall === null)).toBe(true);
  });

  it('build 失敗で stage=build で中断する', async () => {
    const failRunner: StepRunner = async (cmd) =>
      cmd.includes('build') ? { ok: false, code: 1, stdout: '', stderr: 'boom' } : { ok: true, code: 0, stdout: '', stderr: '' };
    const r = await buildRelease(manifest(), { catalog: null, runner: failRunner, skipArchive: true });
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('build');
  });

  it('repo 解決不能なら stage=plan', async () => {
    const m = parseReleaseManifest({
      name: 'demo-allinone',
      primary: 'app',
      output_dir: outRoot,
      components: [{ code: 'app', role: 'primary', path: join(work, 'missing') }],
    });
    const r = await buildRelease(m, { catalog: null, runner: fakeRunner, skipArchive: true });
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('plan');
  });
});
