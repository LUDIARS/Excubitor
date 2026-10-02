/**
 * Infisical → Vault の一括移行。
 *
 * 1. Infisical マッピングを持つサービスごとに、そのマッピング (project / environment / prefix /
 *    include / exclude) で値を取り込み、サービスの「使用する環境変数」に紐付ける。
 * 2. どのサービスにも紐付いていない project は、値だけを取り込む (紐付けない)。environment は
 *    指定値 (既定 dev)。project に無く environment が 1 つだけならそれを使い、それ以外は skip。
 *
 * Infisical project ID ごとの Vault に保存する。共有や他 project の同名とは衝突しない。
 * 同じ project 内に既にある同名が別の値なら上書きせず conflicts で返す。
 * 結果には名前と件数だけを載せ、値は返さない。dryRun は分類だけ返して Vault を変更しない。
 */

import { createNamedLogger } from '../shared/logger.js';
import { toEnvMap, type ExcubitorIdentity, type InfisicalProject, type InfisicalSecret } from '../secrets/infisical.js';
import type { ServiceInfisical } from '../secrets/config-store.js';
import { ENV_NAME_PATTERN } from './vault-store.js';
import type { Vault } from './vault.js';

const logger = createNamedLogger('excubitor.vault.bulk-import');

export const DEFAULT_UNMAPPED_ENVIRONMENT = 'dev';

export interface ImportCounts {
  imported: string[];
  unchanged: string[];
  conflicts: string[];
  /** Vault の変数名として使えない名前 (取り込まない)。 */
  invalid: string[];
}

export interface ServiceImportResult extends ImportCounts {
  code: string;
  project_id: string;
  environment: string;
  error?: string;
}

export interface ProjectImportResult extends ImportCounts {
  project_id: string;
  name: string;
  environment: string | null;
  skipped?: string;
  error?: string;
}

export interface BulkImportResult {
  dry_run: boolean;
  services: ServiceImportResult[];
  projects: ProjectImportResult[];
}

export interface BulkImportDeps {
  vault: Vault;
  identity: ExcubitorIdentity;
  /** Infisical マッピングを持つサービス (config store 優先 / catalog fallback で解決済み)。 */
  services: Array<{ code: string; mapping: ServiceInfisical }>;
  listProjects: (id: ExcubitorIdentity) => Promise<InfisicalProject[]>;
  fetchSecrets: (id: ExcubitorIdentity, projectId: string, environment: string) => Promise<InfisicalSecret[]>;
}

export interface BulkImportOptions {
  dryRun?: boolean;
  /** サービスに紐付かない project で使う environment。 */
  environment?: string;
}

const emptyCounts = (): ImportCounts => ({ imported: [], unchanged: [], conflicts: [], invalid: [] });

/**
 * 1 サービス分を取り込み、同じ値で既にあるものも含めて紐付ける。値の異なる同名 (conflicts) は
 * 紐付けず報告する。単発の取り込み API と一括移行で共有する。
 */
export async function importServiceValues(
  vault: Vault,
  code: string,
  values: Record<string, string>,
  options: { dryRun?: boolean; projectId?: string } = {},
): Promise<ImportCounts> {
  const { valid, invalid } = splitNames(values);
  const target = options.projectId ? vault.forProject(options.projectId) : vault;
  const result = await target.importEntries(valid, options);
  if (!options.dryRun) {
    const names = [...target.bindingsFor(code), ...result.imported, ...result.unchanged];
    if (options.projectId) vault.setProjectBindings(options.projectId, code, names);
    else vault.setBindings(code, names);
  }
  return { ...result, invalid };
}

export async function importAllFromInfisical(deps: BulkImportDeps, options: BulkImportOptions = {}): Promise<BulkImportResult> {
  const dryRun = options.dryRun ?? false;
  const unmappedEnvironment = options.environment?.trim() || DEFAULT_UNMAPPED_ENVIRONMENT;
  const services: ServiceImportResult[] = [];
  const mappedProjects = new Set<string>();
  // Resolve the inventory before any writes; retain stable Infisical project IDs.
  const inventory = await deps.listProjects(deps.identity);

  for (const { code, mapping } of [...deps.services].sort((a, b) => a.code.localeCompare(b.code))) {
    mappedProjects.add(mapping.project_id);
    const base = { code, project_id: mapping.project_id, environment: mapping.environment };
    try {
      const secrets = await deps.fetchSecrets(deps.identity, mapping.project_id, mapping.environment);
      const values = toEnvMap(secrets, { prefix: mapping.prefix, include: mapping.include, exclude: mapping.exclude });
      if (!dryRun) deps.vault.registerProject(mapping.project_id, inventory.find((p) => p.id === mapping.project_id)?.name ?? mapping.project_id);
      services.push({ ...base, ...(await importServiceValues(deps.vault, code, values, { dryRun, projectId: mapping.project_id })) });
    } catch (error) {
      services.push({ ...base, ...emptyCounts(), error: (error as Error).message });
    }
  }

  const projects: ProjectImportResult[] = [];
  for (const project of inventory) {
    if (mappedProjects.has(project.id)) continue;
    const base = { project_id: project.id, name: project.name };
    const environment = pickEnvironment(project, unmappedEnvironment);
    if (!environment) {
      const available = project.environments.map((e) => e.slug).join(', ') || 'なし';
      projects.push({ ...base, environment: null, ...emptyCounts(), skipped: `environment ${unmappedEnvironment} が無い (あるのは ${available})` });
      continue;
    }
    try {
      const secrets = await deps.fetchSecrets(deps.identity, project.id, environment);
      const { valid, invalid } = splitNames(toEnvMap(secrets));
      if (!dryRun) deps.vault.registerProject(project.id, project.name);
      const result = await deps.vault.forProject(project.id).importEntries(valid, { dryRun });
      projects.push({ ...base, environment, ...result, invalid });
    } catch (error) {
      projects.push({ ...base, environment, ...emptyCounts(), error: (error as Error).message });
    }
  }

  logger.info(
    {
      dryRun,
      services: services.length,
      projects: projects.length,
      imported: [...services, ...projects].reduce((n, r) => n + r.imported.length, 0),
      conflicts: [...services, ...projects].reduce((n, r) => n + r.conflicts.length, 0),
    },
    dryRun ? 'planned Infisical bulk import' : 'imported Infisical values into vault (bulk)',
  );
  return { dry_run: dryRun, services, projects };
}

function pickEnvironment(project: InfisicalProject, wanted: string): string | null {
  if (project.environments.some((e) => e.slug === wanted)) return wanted;
  return project.environments.length === 1 ? project.environments[0]!.slug : null;
}

function splitNames(values: Record<string, string>): { valid: Record<string, string>; invalid: string[] } {
  const valid: Record<string, string> = {};
  const invalid: string[] = [];
  for (const [name, value] of Object.entries(values)) {
    // Empty is a valid environment value and differs from an absent entry.
    if (ENV_NAME_PATTERN.test(name)) valid[name] = value;
    else invalid.push(name);
  }
  return { valid, invalid: invalid.sort() };
}
