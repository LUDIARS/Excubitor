/** Privileged catalog fragment の repository trust policy。 */

import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const TRUSTED_GITHUB_OWNER = 'ludiars';

function normalizeAbsolute(path: string): string {
  return resolve(path).replace(/\\/g, '/').replace(/\/+$/, '');
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function explicitTrustedRepositories(): string[] {
  const configured = (process.env.EXCUBITOR_TRUSTED_FRAGMENT_REPOS ?? '').trim();
  return configured.split(',').map((value) => value.trim()).filter(Boolean);
}

function githubOwner(remoteUrl: string): string | null {
  const match = /github\.com[/:]([^/]+)\//i.exec(remoteUrl);
  return match?.[1]?.toLowerCase() ?? null;
}

function gitDirectory(repositoryPath: string): string | null {
  const markerPath = join(repositoryPath, '.git');
  try {
    if (statSync(markerPath).isDirectory()) return markerPath;
    const marker = readFileSync(markerPath, 'utf8');
    const match = /^gitdir:\s*(.+)$/im.exec(marker);
    return match?.[1] ? resolve(repositoryPath, match[1].trim()) : null;
  } catch {
    return null;
  }
}

function originRemoteUrl(repositoryPath: string): string | null {
  const gitDir = gitDirectory(repositoryPath);
  if (!gitDir) return null;

  let commonDir = gitDir;
  try {
    const configuredCommonDir = readFileSync(join(gitDir, 'commondir'), 'utf8').trim();
    if (configuredCommonDir) commonDir = resolve(gitDir, configuredCommonDir);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') return null;
  }

  try {
    const config = readFileSync(join(commonDir, 'config'), 'utf8');
    let isOriginSection = false;
    for (const line of config.split(/\r?\n/)) {
      const section = /^\s*\[([^\]]+)]\s*$/.exec(line);
      if (section) {
        isOriginSection = /^remote\s+"origin"$/i.test(section[1] ?? '');
        continue;
      }
      if (!isOriginSection) continue;
      const url = /^\s*url\s*=\s*(.+?)\s*$/.exec(line);
      if (url?.[1]) return url[1];
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Privileged fragment は明示 allowlist、または LUDIARS GitHub origin を持つ repository に限定する。
 * `.git` が file になる worktree では commondir を解決し、origin URL 以外の設定値は使用しない。
 */
export function isTrustedFragmentRepository(repositoryPath: string, repositoryName: string): boolean {
  const normalizedRepositoryPath = normalizeAbsolute(repositoryPath).toLowerCase();
  const normalizedRepositoryName = repositoryName.toLowerCase();
  if (explicitTrustedRepositories().some((entry) =>
    entry.toLowerCase() === normalizedRepositoryName
    || normalizeAbsolute(entry).toLowerCase() === normalizedRepositoryPath,
  )) {
    return true;
  }

  const remoteUrl = originRemoteUrl(repositoryPath);
  return remoteUrl !== null && githubOwner(remoteUrl) === TRUSTED_GITHUB_OWNER;
}
