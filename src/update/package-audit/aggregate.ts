/**
 * 同一パッケージ/バージョンの更新を 1 件へ集約し、カテゴリ別に数える。
 *
 * @implements SPEC-PACKAGE-UPDATE-AUDIT
 */

import type { PackageUpdate } from './types.js';

export function aggregateUpdates(updates: PackageUpdate[]): PackageUpdate[] {
  const aggregated = new Map<string, PackageUpdate>();
  for (const update of updates) {
    const key = [
      update.scope,
      update.packageName,
      update.current ?? '',
      update.wanted ?? '',
      update.latest,
      update.category,
    ].join('\0');
    const current = aggregated.get(key);
    if (!current) {
      aggregated.set(key, {
        ...update,
        projects: [...update.projects],
        nativeReasons: [...update.nativeReasons],
      });
      continue;
    }
    current.projects = [...new Set([...current.projects, ...update.projects])].sort();
    current.target = current.projects.join(', ');
    current.nativeReasons = [...new Set([...current.nativeReasons, ...update.nativeReasons])].sort();
  }
  const categoryOrder = { native: 0, major: 1, safe: 2 };
  return [...aggregated.values()].sort((a, b) => (
    categoryOrder[a.category] - categoryOrder[b.category]
    || a.packageName.localeCompare(b.packageName)
  ));
}

export function countUpdateCategories(
  updates: PackageUpdate[],
): { safe: number; major: number; native: number } {
  return {
    safe: updates.filter((update) => update.category === 'safe').length,
    major: updates.filter((update) => update.category === 'major').length,
    native: updates.filter((update) => update.category === 'native').length,
  };
}
