/**
 * リリースビルドのオーケストレータ。 plan → build → assemble → launcher → archive を束ねる。
 *
 *   buildRelease(manifest, { catalog })
 *     1. plan: repo パス解決 (失敗なら中断)
 *     2. build: 各 component の build 手順を実行 (skipBuild で省略)
 *     3. assemble: include コピー + prod install (skipInstall で install 省略)
 *     4. runtime: runtime.bundle なら node を同梱
 *     5. launcher: start.bat/sh + bin shim + README + VERSION.json
 *     6. archive: zip 化 (skipArchive で省略)
 */

import { rmSync, mkdirSync, writeFileSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { createNamedLogger } from '../shared/logger.js';
import type { Catalog } from '../catalog/loader.js';
import type { ReleaseManifest } from './manifest.js';
import { planRelease, type ResolvedComponent } from './plan.js';
import { runBuildSteps, defaultStepRunner, type StepRunner, type StepResult } from './steps.js';
import { assembleComponent, type AssembleResult } from './assemble.js';
import { readGitMeta } from './git-meta.js';
import {
  renderStartBat,
  renderStartSh,
  renderCliShimBat,
  renderCliShimSh,
  renderReadme,
  buildVersionInfo,
  type CliBin,
  type LauncherOptions,
  type VersionComponent,
} from './launcher.js';
import { archiveBundle } from './archive.js';

const logger = createNamedLogger('excubitor.release');

export interface BuildReleaseOptions {
  catalog: Catalog | null;
  /** バンドルのバージョン。 省略時は primary の package.json version、 それも無ければ 0.0.0。 */
  version?: string;
  /** build 手順をスキップ (既ビルド成果物をそのまま使う)。 */
  skipBuild?: boolean;
  /** prod install (npm ci --omit=dev) をスキップ。 */
  skipInstall?: boolean;
  /** zip 化をスキップ (フォルダのみ生成)。 */
  skipArchive?: boolean;
  /** 出力ベース dir の上書き (既定は manifest.output_dir)。 */
  outputRoot?: string;
  /** ISO8601 のビルド時刻 (省略時は現在時刻)。 */
  builtAt?: string;
  /** step runner の注入 (テスト用)。 */
  runner?: StepRunner;
}

export interface BuildReleaseResult {
  ok: boolean;
  /** 失敗した段階 (ok=true なら 'done')。 */
  stage: 'plan' | 'build' | 'assemble' | 'done';
  name: string;
  version: string;
  bundleDir: string | null;
  zipPath: string | null;
  errors: string[];
  build: { code: string; steps: StepResult[] }[];
  assemble: AssembleResult[];
  components: VersionComponent[];
}

/** primary の package.json から version を読む (無ければ null)。 */
function readPrimaryVersion(primary: ResolvedComponent | undefined): string | null {
  if (!primary?.repoDir) return null;
  const pkgPath = join(primary.repoDir, 'package.json');
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

export async function buildRelease(
  manifest: ReleaseManifest,
  opts: BuildReleaseOptions,
): Promise<BuildReleaseResult> {
  const runner = opts.runner ?? defaultStepRunner;
  const builtAt = opts.builtAt ?? new Date().toISOString();

  const base: Omit<BuildReleaseResult, 'ok' | 'stage'> = {
    name: manifest.name,
    version: '',
    bundleDir: null,
    zipPath: null,
    errors: [],
    build: [],
    assemble: [],
    components: [],
  };

  // 1. plan
  const plan = planRelease(manifest, opts.catalog);
  if (plan.errors.length > 0) {
    return { ...base, ok: false, stage: 'plan', errors: plan.errors };
  }

  const primary = plan.components.find((c) => c.component.role === 'primary');
  const version = opts.version ?? readPrimaryVersion(primary) ?? '0.0.0';
  base.version = version;

  // 2. build
  if (!opts.skipBuild) {
    for (const rc of plan.buildOrder) {
      if (rc.component.build.length === 0) continue;
      const steps = await runBuildSteps(rc.component.build, rc.repoDir, runner);
      base.build.push({ code: rc.component.code, steps });
      const failed = steps.find((s) => !s.ok);
      if (failed) {
        return {
          ...base,
          ok: false,
          stage: 'build',
          errors: [`component "${rc.component.code}": build 失敗: ${failed.cmd} (code ${failed.code})`],
        };
      }
    }
  }

  // 3. assemble (bundle dir をクリーンに作り直す)
  const outputRoot = resolve(process.cwd(), opts.outputRoot ?? manifest.output_dir);
  const bundleDir = join(outputRoot, `${manifest.name}-${version}`);
  rmSync(bundleDir, { recursive: true, force: true });
  mkdirSync(bundleDir, { recursive: true });
  base.bundleDir = bundleDir;

  for (const rc of plan.components) {
    const effective = opts.skipInstall
      ? { ...rc, component: { ...rc.component, prod_install: false } }
      : rc;
    const result = await assembleComponent(effective, bundleDir, runner);
    base.assemble.push(result);
    if (result.prodInstall && !result.prodInstall.ok) {
      base.errors.push(`component "${rc.component.code}": prod install 失敗`);
    }
  }

  // 4. runtime bundling (任意)
  let bundledNode = false;
  if (manifest.runtime.bundle && manifest.runtime.node_path) {
    const nodeSrc = resolve(process.cwd(), manifest.runtime.node_path);
    if (existsSync(nodeSrc)) {
      const runtimeDir = join(bundleDir, 'runtime');
      mkdirSync(runtimeDir, { recursive: true });
      const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
      copyFileSync(nodeSrc, join(runtimeDir, nodeName));
      bundledNode = true;
    } else {
      base.errors.push(`runtime.node_path が存在しない: ${nodeSrc}`);
    }
  }

  // 5. launcher + VERSION.json
  const cliBins: CliBin[] = plan.components
    .filter((c) => c.component.role === 'cli')
    .map((c) => ({ name: c.component.bin_name!, subdir: c.bundleSubdir, entry: c.component.bin_entry! }));

  const versionComponents: VersionComponent[] = [];
  for (const rc of plan.components) {
    const meta = await readGitMeta(rc.repoDir);
    versionComponents.push({ code: rc.component.code, role: rc.component.role, ...meta });
  }
  base.components = versionComponents;

  const launcherOpts: LauncherOptions = {
    name: manifest.name,
    displayName: manifest.display_name ?? manifest.name,
    version,
    startCmd: manifest.start_command.cmd,
    startArgs: manifest.start_command.args,
    cliBins,
    bundledNode,
    readmeNotes: manifest.readme_notes,
  };

  writeFileSync(join(bundleDir, 'start.bat'), renderStartBat(launcherOpts));
  writeFileSync(join(bundleDir, 'start.sh'), renderStartSh(launcherOpts), { mode: 0o755 });
  writeFileSync(join(bundleDir, 'README.txt'), renderReadme(launcherOpts));
  writeFileSync(
    join(bundleDir, 'VERSION.json'),
    JSON.stringify(buildVersionInfo(manifest.name, version, builtAt, versionComponents), null, 2),
  );

  if (cliBins.length > 0) {
    const binDir = join(bundleDir, 'bin');
    mkdirSync(binDir, { recursive: true });
    for (const bin of cliBins) {
      writeFileSync(join(binDir, `${bin.name}.cmd`), renderCliShimBat(bin, bundledNode));
      writeFileSync(join(binDir, bin.name), renderCliShimSh(bin, bundledNode), { mode: 0o755 });
    }
  }

  // 6. archive
  let zipPath: string | null = null;
  if (!opts.skipArchive) {
    const out = join(outputRoot, `${manifest.name}-${version}.zip`);
    const arch = await archiveBundle(bundleDir, out);
    if (arch.ok) {
      zipPath = arch.zipPath;
    } else {
      base.errors.push(`zip 化失敗: ${arch.stderr}`);
    }
  }
  base.zipPath = zipPath;

  const ok = base.errors.length === 0;
  logger.info({ name: manifest.name, version, bundleDir, zipPath, ok }, 'release build finished');
  return { ...base, ok, stage: 'done' };
}
