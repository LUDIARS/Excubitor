/**
 * 各サービスリポが自分の Excubitor catalog 定義を持つ「断片 (fragment)」を集積する。
 *
 * fragment の探索、内容 fingerprint、last-known-good の保持をこのモジュールに集約する。
 * 明示設定された workspace root だけを privileged fragment の信頼境界とし、loader が
 * secret 関連フィールドを受理するか判断できるよう source ごとの trust 情報も返す。
 */

import { createHash } from 'node:crypto';
import { type Dirent, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { load } from 'js-yaml';
import { createNamedLogger } from '../shared/logger.js';
import { arsRoot } from '../shared/roots.js';
import { isTrustedFragmentRepository } from './fragment-trust.js';
import { interpolateRoots } from './interpolate.js';

const logger = createNamedLogger('excubitor.catalog.fragments');

/** 各サービスリポ直下に置く断片ファイル名。 */
export const FRAGMENT_FILENAME = 'excubitor.catalog.yaml';

export interface FragmentServiceEntry {
  service: unknown;
  source: string;
  /** true when both the discovery root and repository identity are explicitly trusted. */
  trusted: boolean;
}

export interface FragmentIssue {
  kind: 'root-read' | 'file-stat' | 'file-read' | 'yaml-parse' | 'document-shape';
  source: string;
  message: string;
  /** Whether services from the last successful read were retained. */
  retained: boolean;
}

export interface FragmentAggregate {
  /** 集積した生の service エントリ (未検証、 loader が zod で検証する)。 */
  services: unknown[];
  /** source/trust を保持した service エントリ。 */
  entries: FragmentServiceEntry[];
  /** 断片を読んだファイルパス (診断用)。 */
  sources: string[];
  /** 現在の探索・読込で発生した診断。 */
  issues: FragmentIssue[];
}

interface FragmentRoot {
  path: string;
  trusted: boolean;
}

interface FragmentSource {
  path: string;
  trusted: boolean;
}

interface FragmentDiscovery {
  sources: FragmentSource[];
  failedRoots: FragmentRoot[];
  issues: FragmentIssue[];
}

interface CachedFragment {
  fingerprint: string;
  services: unknown[];
}

interface AggregateCache {
  key: string;
  aggregate: FragmentAggregate;
}

const fileCache = new Map<string, CachedFragment>();
let aggregateCache: AggregateCache | null = null;

/** forward-slash 正規化 + 末尾スラッシュ除去 (roots.ts と同じ表記に揃える)。 */
function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

function normalizeAbsolute(path: string): string {
  return normalize(resolve(path));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function fingerprint(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function hasExplicitWorkspaceRoot(): boolean {
  return Boolean((process.env.EXCUBITOR_ARS_ROOT ?? process.env.LUDIARS_ROOT ?? '').trim());
}

/**
 * 走査ルート一覧。cwd の親という暗黙 fallback は通常 fragment には使えるが、secret 取得等の
 * privileged fields を許可する trust boundary にはしない。env 追加ルートは明示設定なので trusted。
 */
function configuredFragmentRoots(): FragmentRoot[] {
  const roots: FragmentRoot[] = [
    { path: normalizeAbsolute(arsRoot()), trusted: hasExplicitWorkspaceRoot() },
  ];
  const extra = (process.env.EXCUBITOR_FRAGMENT_DIRS ?? '').trim();
  if (extra) {
    for (const path of extra.split(',').map((value) => value.trim()).filter(Boolean)) {
      roots.push({ path: normalizeAbsolute(path), trusted: true });
    }
  }

  const deduplicated = new Map<string, FragmentRoot>();
  for (const root of roots) {
    const previous = deduplicated.get(root.path);
    deduplicated.set(root.path, { path: root.path, trusted: root.trusted || previous?.trusted === true });
  }
  return [...deduplicated.values()];
}

/** watcher が監視する discovery roots。 */
export function fragmentRoots(): string[] {
  return configuredFragmentRoots().map((root) => root.path);
}

function discoverFragmentSources(resolveTrust = false): FragmentDiscovery {
  const sources = new Map<string, FragmentSource>();
  const failedRoots: FragmentRoot[] = [];
  const issues: FragmentIssue[] = [];

  for (const root of configuredFragmentRoots()) {
    let children: Dirent[];
    try {
      children = readdirSync(root.path, { withFileTypes: true });
    } catch (error) {
      failedRoots.push(root);
      issues.push({
        kind: 'root-read',
        source: root.path,
        message: errorMessage(error),
        retained: false,
      });
      continue;
    }

    for (const child of children) {
      // Symlinks/junctions are intentionally outside the configured trust boundary.
      if (!child.isDirectory()) continue;
      const repositoryPath = normalizeAbsolute(join(root.path, child.name));
      const path = normalizeAbsolute(join(repositoryPath, FRAGMENT_FILENAME));
      try {
        if (!statSync(path).isFile()) continue;
      } catch (error) {
        if (errorCode(error) === 'ENOENT') continue;
        const retained = fileCache.has(path);
        issues.push({
          kind: 'file-stat',
          source: path,
          message: errorMessage(error),
          retained,
        });
        if (retained) {
          sources.set(path, {
            path,
            trusted: root.trusted && (!resolveTrust || isTrustedFragmentRepository(repositoryPath, child.name)),
          });
        }
        continue;
      }

      const previous = sources.get(path);
      const trusted = root.trusted
        && (!resolveTrust || isTrustedFragmentRepository(repositoryPath, child.name));
      sources.set(path, { path, trusted: trusted || previous?.trusted === true });
    }
  }

  return {
    sources: [...sources.values()].sort((left, right) => left.path.localeCompare(right.path)),
    failedRoots,
    issues,
  };
}

/** 各ルート直下の `<child>/excubitor.catalog.yaml` を列挙 (存在するもののみ、 昇順)。 */
export function fragmentFiles(): string[] {
  return discoverFragmentSources().sources.map((source) => source.path);
}

function isWithinRoot(path: string, root: string): boolean {
  const child = relative(root, path);
  return child.length > 0 && !child.startsWith('..') && !isAbsolute(child);
}

function parseServices(content: string): unknown[] {
  const parsed = load(content);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError('fragment top-level must be an object with a services array');
  }
  const services = (parsed as { services?: unknown }).services;
  if (!Array.isArray(services)) {
    throw new TypeError('fragment top-level services must be an array');
  }
  return services;
}

function retainFailedRootSources(discovery: FragmentDiscovery): FragmentSource[] {
  const retained: FragmentSource[] = [];
  for (const root of discovery.failedRoots) {
    let retainedAny = false;
    for (const path of fileCache.keys()) {
      if (!isWithinRoot(path, root.path)) continue;
      retained.push({ path, trusted: root.trusted });
      retainedAny = true;
    }
    const issue = discovery.issues.find((candidate) =>
      candidate.kind === 'root-read' && candidate.source === root.path,
    );
    if (issue) issue.retained = retainedAny;
  }
  return retained;
}

function logIssues(issues: FragmentIssue[]): void {
  for (const issue of issues) {
    logger.warn(
      { kind: issue.kind, source: issue.source, err: issue.message, retained: issue.retained },
      'catalog fragment load issue',
    );
  }
}

/**
 * watcher 用の内容 revision。mtime ではなく内容 hash を使うため、timestamp を保持した更新や
 * file-watch が利用不能な環境でも polling で変化を検出できる。
 */
export function fragmentRevision(): string {
  const discovery = discoverFragmentSources();
  const parts = discovery.issues.map((issue) => `${issue.kind}:${issue.source}:${issue.message}`);
  for (const source of discovery.sources) {
    try {
      parts.push(`${source.path}:${fingerprint(readFileSync(source.path, 'utf8'))}`);
    } catch (error) {
      parts.push(`${source.path}:read-error:${errorMessage(error)}`);
    }
  }
  return parts.sort().join('|');
}

/**
 * ワークスペース配下の断片を集積する。各 file の内容 hash が同一なら parse 結果を再利用する。
 * 探索・読込・YAML/shape 検証が一時的に失敗した場合は、その source の last-known-good を保持し、
 * 問題を issues と warning log の両方で観測可能にする。
 */
export function readFragmentServicesRaw(): FragmentAggregate {
  const discovery = discoverFragmentSources(true);
  const sourceMap = new Map<string, FragmentSource>();
  for (const source of [...discovery.sources, ...retainFailedRootSources(discovery)]) {
    const previous = sourceMap.get(source.path);
    sourceMap.set(source.path, { path: source.path, trusted: source.trusted || previous?.trusted === true });
  }

  const entries: FragmentServiceEntry[] = [];
  const sources: string[] = [];
  const activeCachePaths = new Set<string>();
  const revisionParts: string[] = [];
  const discoveredPaths = new Set(discovery.sources.map((source) => source.path));

  for (const source of [...sourceMap.values()].sort((left, right) => left.path.localeCompare(right.path))) {
    const previous = fileCache.get(source.path);
    let current = previous;
    let contentHash = previous?.fingerprint ?? 'none';

    if (discoveredPaths.has(source.path)) {
      try {
        const content = interpolateRoots(readFileSync(source.path, 'utf8'));
        contentHash = fingerprint(content);
        if (!previous || previous.fingerprint !== contentHash) {
          try {
            current = { fingerprint: contentHash, services: parseServices(content) };
            fileCache.set(source.path, current);
          } catch (error) {
            const kind = error instanceof TypeError ? 'document-shape' : 'yaml-parse';
            discovery.issues.push({
              kind,
              source: source.path,
              message: errorMessage(error),
              retained: previous !== undefined,
            });
          }
        }
      } catch (error) {
        discovery.issues.push({
          kind: 'file-read',
          source: source.path,
          message: errorMessage(error),
          retained: previous !== undefined,
        });
      }
    }

    if (!current) {
      revisionParts.push(`${source.path}:${contentHash}:unavailable`);
      continue;
    }

    activeCachePaths.add(source.path);
    revisionParts.push(`${source.path}:${contentHash}:${current.fingerprint}:${source.trusted}`);
    if (current.services.length > 0) sources.push(source.path);
    for (const service of current.services) {
      entries.push({ service, source: source.path, trusted: source.trusted });
    }
  }

  for (const path of fileCache.keys()) {
    if (!activeCachePaths.has(path)) fileCache.delete(path);
  }

  const issueKey = discovery.issues
    .map((issue) => `${issue.kind}:${issue.source}:${issue.message}:${issue.retained}`)
    .sort()
    .join('|');
  const key = `${revisionParts.sort().join('|')}#${issueKey}`;
  if (aggregateCache?.key === key) return aggregateCache.aggregate;

  const aggregate: FragmentAggregate = {
    services: entries.map((entry) => entry.service),
    entries,
    sources,
    issues: discovery.issues,
  };
  logIssues(aggregate.issues);
  aggregateCache = { key, aggregate };
  return aggregate;
}

/** テスト用: 集積キャッシュを破棄する。 */
export function clearFragmentCache(): void {
  fileCache.clear();
  aggregateCache = null;
}
