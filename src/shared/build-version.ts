import { execCapture } from './exec.js';
import type { Catalog } from '../catalog/loader.js';

export interface BuildVersionInfo {
  project_code: string;
  major: number;
  minor: number;
  patch: number;
  version: string;
  patch_source: 'env' | 'git' | 'fallback';
  git_hash: string | null;
}

export async function resolveBuildVersion(
  catalog: Catalog,
  projectCode: string,
  cwd = process.cwd(),
): Promise<BuildVersionInfo | null> {
  const base = catalog.project_versions[projectCode];
  if (!base) return null;

  const envPatch = envBuildNumber(projectCode);
  const [gitCount, gitHash] = await Promise.all([
    envPatch === null ? gitCommitCount(cwd) : Promise.resolve(null),
    gitShortHash(cwd),
  ]);
  const patch = envPatch ?? gitCount ?? 0;
  return {
    project_code: projectCode,
    major: base.major,
    minor: base.minor,
    patch,
    version: `${base.major}.${base.minor}.${patch}`,
    patch_source: envPatch !== null ? 'env' : gitCount !== null ? 'git' : 'fallback',
    git_hash: gitHash,
  };
}

function envBuildNumber(projectCode: string): number | null {
  const key = projectCode.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const candidates = [
    `${key}_BUILD_NUMBER`,
    `${key}_BUILD_VERSION_PATCH`,
    'LUDIARS_BUILD_NUMBER',
    'BUILD_NUMBER',
  ];
  for (const candidate of candidates) {
    const raw = process.env[candidate]?.trim();
    if (!raw) continue;
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

async function gitCommitCount(cwd: string): Promise<number | null> {
  const result = await execCapture('git', ['rev-list', '--count', 'HEAD'], cwd, 5000);
  if (!result.ok) return null;
  const parsed = Number(result.stdout.trim());
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

async function gitShortHash(cwd: string): Promise<string | null> {
  const result = await execCapture('git', ['rev-parse', '--short=12', 'HEAD'], cwd, 5000);
  if (!result.ok) return null;
  return result.stdout.trim() || null;
}
