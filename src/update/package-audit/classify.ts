/**
 * 更新を safe / major / native のいずれか 1 つへ分類する。
 *
 * @implements SPEC-PACKAGE-UPDATE-AUDIT
 */

import type {
  NpmOutdatedEntry,
  PackageUpdateCategory,
  SemverImpact,
} from './types.js';

interface SemverCore {
  major: number;
  minor: number;
}

/**
 * npm の version 欄は通常 semver だが、git/link 指定も取り得る。
 * 解釈不能な値は「安全」と断定せず breaking 側へ倒す。
 */
function parseSemverCore(value: string | null | undefined): SemverCore | null {
  if (!value) return null;
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.\d+(?:[-+].*)?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
  };
}

export function isBreakingVersionChange(
  current: string | null | undefined,
  latest: string | null | undefined,
): boolean {
  const from = parseSemverCore(current);
  const to = parseSemverCore(latest);
  if (!from || !to) return true;
  if (from.major !== to.major) return true;
  // SemVer では 0.x の API は安定保証がないため minor 境界も破壊的として扱う。
  return from.major === 0 && from.minor !== to.minor;
}

export function localSemverImpact(entry: NpmOutdatedEntry): SemverImpact {
  if (!entry.latest || !entry.wanted) return 'breaking';
  // wanted は package.json の宣言レンジを満たす最大、latest は registry の latest tag。
  return entry.wanted === entry.latest ? 'safe' : 'breaking';
}

export function globalSemverImpact(entry: NpmOutdatedEntry): SemverImpact {
  return isBreakingVersionChange(entry.current, entry.latest) ? 'breaking' : 'safe';
}

export function updateCategory(
  semverImpact: SemverImpact,
  requiresRebuild: boolean,
): PackageUpdateCategory {
  if (requiresRebuild) return 'native';
  return semverImpact === 'breaking' ? 'major' : 'safe';
}
