/**
 * リリースビルドの headless CLI。 サーバを起動せずに 1 バンドルを焼く入口。
 *
 *   npm run release -- <name|path.yaml> [--version <v>] [--dry-run]
 *                      [--skip-build] [--skip-install] [--skip-archive]
 *
 * <name> は releases/<name>.yaml を指す。 .yaml/.yml 拡張子付きならパス直指定。
 * --dry-run は plan (repo 解決 + git meta) のみ表示してビルドしない。
 */

import { listReleaseManifests, loadReleaseManifest } from './manifest.js';
import { planRelease } from './plan.js';
import { buildRelease } from './orchestrator.js';
import { loadCatalog, type Catalog } from '../catalog/loader.js';

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function resolveManifestPath(target: string): string | null {
  if (/\.ya?ml$/.test(target)) return target;
  return listReleaseManifests().find((m) => m.name === target)?.path ?? null;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const target = argv.find((a) => !a.startsWith('--'));
  if (!target) {
    console.error('usage: npm run release -- <name|path.yaml> [--version <v>] [--dry-run] [--skip-build] [--skip-install] [--skip-archive]');
    console.error('manifests:', listReleaseManifests().map((m) => m.name).join(', ') || '(none)');
    process.exit(2);
  }

  const path = resolveManifestPath(target);
  if (!path) {
    console.error(`manifest not found: ${target}`);
    console.error('available:', listReleaseManifests().map((m) => m.name).join(', ') || '(none)');
    process.exit(2);
  }

  const manifest = loadReleaseManifest(path);

  // catalog は repo パス解決の補助 (component が path 明示なら不要)。 読めなくても続行。
  let catalog: Catalog | null = null;
  try {
    catalog = loadCatalog();
  } catch {
    catalog = null;
  }

  if (hasFlag(argv, '--dry-run')) {
    const plan = planRelease(manifest, catalog);
    console.log(JSON.stringify(
      {
        name: manifest.name,
        errors: plan.errors,
        components: plan.components.map((c) => ({
          code: c.component.code,
          role: c.component.role,
          repoDir: c.repoDir || null,
          bundleSubdir: c.bundleSubdir,
          build: c.component.build,
        })),
      },
      null,
      2,
    ));
    process.exit(plan.errors.length === 0 ? 0 : 1);
  }

  const result = await buildRelease(manifest, {
    catalog,
    version: flagValue(argv, '--version'),
    skipBuild: hasFlag(argv, '--skip-build'),
    skipInstall: hasFlag(argv, '--skip-install'),
    skipArchive: hasFlag(argv, '--skip-archive'),
  });

  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.error('[release] failed:', err);
  process.exit(1);
});
