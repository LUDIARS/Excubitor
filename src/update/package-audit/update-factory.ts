/**
 * npm の生出力を 1 件の PackageUpdate へ組み立てる。
 *
 * @implements SPEC-PACKAGE-UPDATE-AUDIT
 */

import { join, resolve } from 'node:path';

import {
  globalSemverImpact,
  localSemverImpact,
  updateCategory,
} from './classify.js';
import { detectNativePackage } from './native-detector.js';
import type { LocalPackageTarget } from './targets.js';
import type { NpmOutdatedEntry, PackageUpdate } from './types.js';

export function localPackageUpdate(
  target: LocalPackageTarget,
  packageName: string,
  entry: NpmOutdatedEntry,
): PackageUpdate | null {
  if (!entry.latest) return null;
  const packageDir = entry.location
    ? resolve(target.cwd, entry.location)
    : resolve(target.cwd, 'node_modules', packageName);
  const native = detectNativePackage(packageDir);
  const semverImpact = localSemverImpact(entry);
  return {
    scope: 'local',
    target: localTargetLabel(target),
    projects: [...target.projects],
    packageName,
    current: entry.current ?? null,
    wanted: entry.wanted ?? null,
    latest: entry.latest,
    category: updateCategory(semverImpact, native.requiresRebuild),
    semverImpact,
    requiresRebuild: native.requiresRebuild,
    nativeReasons: native.reasons,
    dependencyType: entry.type ?? null,
    releaseNotes: null,
    releaseUrl: null,
  };
}

export function globalPackageUpdate(
  packageName: string,
  entry: NpmOutdatedEntry,
  globalRoot: string | null,
): PackageUpdate | null {
  if (!entry.latest) return null;
  const native = detectNativePackage(globalRoot ? join(globalRoot, packageName) : null);
  const semverImpact = globalSemverImpact(entry);
  return {
    scope: 'global',
    target: 'global',
    projects: ['global'],
    packageName,
    current: entry.current ?? null,
    wanted: entry.wanted ?? null,
    latest: entry.latest,
    category: updateCategory(semverImpact, native.requiresRebuild),
    semverImpact,
    requiresRebuild: native.requiresRebuild,
    nativeReasons: native.reasons,
    dependencyType: entry.type ?? 'cli',
    releaseNotes: null,
    releaseUrl: null,
  };
}

export function localTargetLabel(target: LocalPackageTarget): string {
  return target.projects.join(', ');
}
