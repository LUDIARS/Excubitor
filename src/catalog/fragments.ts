/**
 * 各サービスリポが自分の Excubitor catalog 定義を持つ「断片 (fragment)」を集積する。
 *
 * fragment の探索、内容 fingerprint、last-known-good の保持をこのモジュールに集約する。
 * service definition は runnable command を含むため、loader が受理可否を判断できるよう
 * source ごとの repository trust (LUDIARS origin か明示 allowlist) も返す。
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

interface FragmentSource {
  path: string;
  trusted: boolean;
}

interface FragmentDiscovery {
  sources: FragmentSource[];
  failedRoots: string[];
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
/** source ごとに最後に解決できた repository trust。root が一時的に読めない間の retention で使う。 */
const trustCache = new Map<string, boolean>();
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

/**
 * 走査ルート一覧。
 *
 * service definition は runnable command を含むため、trust の判断は root ではなく
 * **repository 単位** (LUDIARS origin または `EXCUBITOR_TRUSTED_FRAGMENT_REPOS` の明示 allowlist、
 * `fragment-trust.ts`) で行う。ARS_ROOT が env 明示か cwd の親 fallback かで root を untrusted に
 * すると、既定構成 (env 未設定 = cwd の親) では全 service が untrusted 判定になり catalog が
 * 空になる — 監視も起動もできなくなるため、root 自体は trusted とし repository 側で fail-closed する。
 */
function configuredFragmentRoots(): string[] {
  const roots = [normalizeAbsolute(arsRoot())];
  const extra = (process.env.EXCUBITOR_FRAGMENT_DIRS ?? '').trim();
  if (extra) {
    for (const path of extra.split(',').map((value) => value.trim()).filter(Boolean)) {
      roots.push(normalizeAbsolute(path));
    }
  }
  return [...new Set(roots)];
}

/** watcher が監視する discovery roots。 */
export function fragmentRoots(): string[] {
  return configuredFragmentRoots();
}

/**
 * source が信頼できる repository のものか判定する。
 * 列挙目的の呼び出し (resolveTrust=false) では判定を省く。
 */
function resolveRepositoryTrust(
  repositoryPath: string,
  repositoryName: string,
  resolveTrust: boolean,
): boolean {
  return !resolveTrust || isTrustedFragmentRepository(repositoryPath, repositoryName);
}

function discoverFragmentSources(resolveTrust = false): FragmentDiscovery {
  const sources = new Map<string, FragmentSource>();
  const failedRoots: string[] = [];
  const issues: FragmentIssue[] = [];

  for (const root of configuredFragmentRoots()) {
    let children: Dirent[];
    try {
      children = readdirSync(root, { withFileTypes: true });
    } catch (error) {
      failedRoots.push(root);
      issues.push({
        kind: 'root-read',
        source: root,
        message: errorMessage(error),
        retained: false,
      });
      continue;
    }

    for (const child of children) {
      // Symlinks/junctions are intentionally outside the configured trust boundary.
      if (!child.isDirectory()) continue;
      const repositoryPath = normalizeAbsolute(join(root, child.name));
      // git worktree は一時的な作業コピーであり、 本番 catalog の供給源にしない。
      // 未マージブランチのサービス定義が混ざるうえ、 本体リポと同じ code を二重供給して
      // マージ順で勝敗が決まる不安定な状態を生む (2026-07-26 実測: ARS_ROOT 直下の
      // worktree 4 件が ludellus-web / PrivateGame-unity-validation / volputas x2 を供給し、
      // ludellus-web は本体リポのどこにも存在しなかった)。
      if (isGitWorktree(repositoryPath)) continue;
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
          sources.set(path, { path, trusted: resolveRepositoryTrust(repositoryPath, child.name, resolveTrust) });
        }
        continue;
      }

      const previous = sources.get(path);
      const trusted = resolveRepositoryTrust(repositoryPath, child.name, resolveTrust);
      sources.set(path, { path, trusted: trusted || previous?.trusted === true });
    }
  }

  // root が読めなくなった間の retention 用に、解決できた trust を source ごとに控える。
  if (resolveTrust) {
    for (const source of sources.values()) trustCache.set(source.path, source.trusted);
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

/**
 * git worktree のルートかどうか。
 *
 * worktree は `.git` を **ファイル** (`gitdir: ...` を書いた参照) として持ち、 通常のリポジトリは
 * ディレクトリとして持つ。 `.git` を一切持たないディレクトリ (Castra の `scripts/` など、
 * 親リポの一部として fragment を提供するもの) は従来どおり対象に残す。
 */
function isGitWorktree(directory: string): boolean {
  try {
    return statSync(join(directory, '.git')).isFile();
  } catch {
    return false;
  }
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
  const topLevelKeys = Object.keys(parsed as Record<string, unknown>);
  if (topLevelKeys.some((key) => key !== 'services')) {
    throw new TypeError('service-owned catalog top-level may only contain services');
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
      if (!isWithinRoot(path, root)) continue;
      // repository を再確認できないので、最後に解決できた trust を引き継ぐ (未解決なら fail-closed)。
      retained.push({ path, trusted: trustCache.get(path) ?? false });
      retainedAny = true;
    }
    const issue = discovery.issues.find((candidate) =>
      candidate.kind === 'root-read' && candidate.source === root,
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
  for (const path of trustCache.keys()) {
    if (!activeCachePaths.has(path)) trustCache.delete(path);
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
  trustCache.clear();
  aggregateCache = null;
}
