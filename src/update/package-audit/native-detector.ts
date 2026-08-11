/**
 * インストール済みマニフェストからネイティブビルドを要する更新を見分ける。
 *
 * @implements SPEC-PACKAGE-UPDATE-AUDIT
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

interface PackageManifest {
  gypfile?: boolean;
  binary?: unknown;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export interface NativeDetection {
  requiresRebuild: boolean;
  reasons: string[];
}

const NATIVE_BUILD_TOOLS = new Set([
  '@mapbox/node-pre-gyp',
  'cmake-js',
  'nan',
  'node-addon-api',
  'node-gyp',
  'prebuild-install',
]);

const NATIVE_SCRIPT_PATTERN =
  /\b(node-gyp|node-pre-gyp|prebuild-install|cmake-js|cargo-cp-artifact|napi\s+(?:build|artifacts))\b/i;

export function detectNativePackage(packageDir: string | null): NativeDetection {
  if (!packageDir) return { requiresRebuild: false, reasons: [] };
  const manifestPath = resolve(packageDir, 'package.json');
  if (!existsSync(manifestPath)) return { requiresRebuild: false, reasons: [] };

  let manifest: PackageManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageManifest;
  } catch {
    return { requiresRebuild: false, reasons: [] };
  }

  const reasons = new Set<string>();
  if (manifest.gypfile === true || existsSync(join(packageDir, 'binding.gyp'))) {
    reasons.add('binding.gyp');
  }
  if (manifest.binary && typeof manifest.binary === 'object') reasons.add('binary manifest');

  for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
    if (NATIVE_SCRIPT_PATTERN.test(command)) reasons.add(`${name} script`);
  }

  const dependencyNames = Object.keys({
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...manifest.devDependencies,
  });
  for (const dependencyName of dependencyNames) {
    if (NATIVE_BUILD_TOOLS.has(dependencyName)) reasons.add(`depends on ${dependencyName}`);
  }

  return { requiresRebuild: reasons.size > 0, reasons: [...reasons].sort() };
}
