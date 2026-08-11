/**
 * catalog 管理下サービスから package.json を持つ作業ディレクトリを重複なく返す。
 *
 * @implements SPEC-PACKAGE-UPDATE-AUDIT
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Catalog } from '../../catalog/loader.js';
import { repoDirOf } from '../checker.js';

export interface LocalPackageTarget {
  projects: string[];
  cwd: string;
}

/** catalog 管理下サービスから package.json を持つ作業ディレクトリを重複なく返す。 */
export function packageTargetsFromCatalog(catalog: Catalog): LocalPackageTarget[] {
  const byDirectory = new Map<string, LocalPackageTarget>();
  for (const service of catalog.services) {
    const repoDir = repoDirOf(service);
    if (!repoDir) continue;
    const cwd = resolve(repoDir);
    if (!existsSync(resolve(cwd, 'package.json'))) continue;
    const project = service.project_code ?? service.code;
    const existing = byDirectory.get(cwd);
    if (existing) {
      if (!existing.projects.includes(project)) existing.projects.push(project);
    } else {
      byDirectory.set(cwd, { projects: [project], cwd });
    }
  }
  return [...byDirectory.values()].sort((a, b) => a.cwd.localeCompare(b.cwd));
}
