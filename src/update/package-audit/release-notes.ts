/**
 * 更新対象の GitHub リポジトリからリリースノートを引き当てる。
 *
 * @implements SPEC-PACKAGE-UPDATE-AUDIT
 */

import type { NpmInvocation, NpmPackageMetadata } from './npm-client.js';
import { npmPackageMetadata } from './npm-client.js';
import type { PackageAuditIssue, PackageUpdate } from './types.js';

interface GitHubRelease {
  tag_name?: string;
  name?: string;
  body?: string;
  html_url?: string;
}

interface GitHubRepository {
  owner: string;
  repo: string;
}

export interface ReleaseNoteOptions {
  cwd: string;
  invocation: NpmInvocation;
  timeoutMs: number;
  maxPackages: number;
  fetchImpl?: typeof fetch;
}

export async function enrichReleaseNotes(
  updates: PackageUpdate[],
  options: ReleaseNoteOptions,
): Promise<{ updates: PackageUpdate[]; issues: PackageAuditIssue[] }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const unique = new Map<string, PackageUpdate>();
  for (const update of updates) unique.set(`${update.packageName}\0${update.latest}`, update);
  const selected = [...unique.values()].slice(0, options.maxPackages);
  const notes = new Map<string, { text: string | null; url: string | null }>();
  const issues: PackageAuditIssue[] = [];
  const queue = [...selected];

  async function worker(): Promise<void> {
    for (;;) {
      const update = queue.shift();
      if (!update) return;
      const key = `${update.packageName}\0${update.latest}`;
      const result = await npmPackageMetadata(
        options.invocation,
        options.cwd,
        options.timeoutMs,
        update.packageName,
        update.latest,
      );
      if (!result.ok) {
        issues.push({
          scope: update.scope,
          target: update.packageName,
          code: 'release_notes_metadata_failed',
          message: result.failure.message,
        });
        notes.set(key, { text: null, url: null });
        continue;
      }
      notes.set(key, await findGitHubRelease(result.value, update.latest, fetchImpl));
    }
  }

  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, () => worker()));
  if (unique.size > selected.length) {
    issues.push({
      scope: 'local',
      target: 'release-notes',
      code: 'release_notes_limit',
      message: `release notes limited to ${selected.length} of ${unique.size} package versions`,
    });
  }

  return {
    updates: updates.map((update) => {
      const release = notes.get(`${update.packageName}\0${update.latest}`);
      return release
        ? { ...update, releaseNotes: release.text, releaseUrl: release.url }
        : update;
    }),
    issues,
  };
}

async function findGitHubRelease(
  metadata: NpmPackageMetadata,
  version: string,
  fetchImpl: typeof fetch,
): Promise<{ text: string | null; url: string | null }> {
  const repository = githubRepository(metadata.repository);
  if (!repository) {
    return { text: null, url: null };
  }
  const repositoryUrl = `https://github.com/${repository.owner}/${repository.repo}`;
  try {
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'user-agent': 'Excubitor-package-audit',
      'x-github-api-version': '2022-11-28',
    };
    const token = process.env.GITHUB_TOKEN?.trim();
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetchImpl(
      `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/releases?per_page=30`,
      {
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!response.ok) return { text: null, url: `${repositoryUrl}/releases` };
    const releases = await response.json() as GitHubRelease[];
    const release = releases.find((candidate) => tagMatchesVersion(candidate.tag_name, version));
    if (!release) return { text: null, url: `${repositoryUrl}/releases` };
    return {
      text: summarizeRelease(release),
      url: normalizeGitHubUrl(release.html_url) ?? `${repositoryUrl}/releases`,
    };
  } catch {
    return { text: null, url: `${repositoryUrl}/releases` };
  }
}

function githubRepository(repository: NpmPackageMetadata['repository']): GitHubRepository | null {
  const raw = typeof repository === 'string' ? repository : repository?.url;
  if (!raw) return null;
  const normalized = raw
    .replace(/^git\+/, '')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/^github:/, 'https://github.com/');
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return null;
  }
  if (url.hostname.toLowerCase() !== 'github.com') return null;
  const parts = url.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
  const owner = parts[0];
  const repo = parts[1];
  if (!owner || !repo || !/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    return null;
  }
  return { owner, repo };
}

function tagMatchesVersion(tag: string | undefined, version: string): boolean {
  if (!tag) return false;
  return tag === version
    || tag === `v${version}`
    || tag.endsWith(`@${version}`)
    || tag.endsWith(`-${version}`);
}

function summarizeRelease(release: GitHubRelease): string | null {
  const body = release.body
    ?.replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/(?:#|\*|_|`|>|\||\[|\])/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const summary = body || release.name?.trim();
  if (!summary) return null;
  return summary.length <= 420 ? summary : `${summary.slice(0, 417)}...`;
}

function normalizeGitHubUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.toLowerCase() === 'github.com'
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}
