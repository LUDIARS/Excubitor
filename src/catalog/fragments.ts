/**
 * 各サービスリポが自分の Excubitor catalog 定義を持つ「断片 (fragment)」を集積する。
 *
 * 目的: 公開 Excubitor リポの `catalog/services.yaml` に private リポの定義
 * (repo 名 / ポート / トポロジ) を焼き込まないため、 各サービスの catalog エントリを
 * *そのサービス自身のリポ* に置き、 Excubitor はワークスペース配下を走査して集めるだけにする。
 *
 * 探索対象:
 *   1. `${ARS_ROOT}/<repo>/excubitor.catalog.yaml`  (各ローカルクローン直下、 1 階層)
 *   2. env `EXCUBITOR_FRAGMENT_DIRS` (カンマ区切りの追加ルート、
 *      各ルート直下の `<child>/excubitor.catalog.yaml` を走査)
 *
 * 断片ファイルの形 (services.yaml の services エントリと同一スキーマ):
 *   services:
 *     - code: foo
 *       name: Foo
 *       ...
 *   top-level は services のみ (project_versions 等の全体設定は持たない)。
 *
 * 一時エラーとサービス削除の区別 (可用性/機密の両面で重要):
 *   走査 (readdir/stat) や読み込み/parse が *一時的に* 失敗しても、 それを「サービスが
 *   消えた」 とは扱わない。 直近の成功結果 (last-known-good) を保持し、 集積結果から
 *   既存サービスが黙って消えて DB 上 deactivate されるのを防ぐ。 genuine な削除
 *   (ENOENT = ファイル/ディレクトリが実際に無い) のときのみ last-known-good を破棄する。
 *
 * キャッシュ: 断片の *内容ハッシュ* をキーに per-file でメモリキャッシュする。 mtime に
 * 依存しないため、 mtime を変えずに内容だけ書き換わったケースも取りこぼさない。
 * 個々の断片は独立に読み、 壊れた 1 ファイルで全体を壊さない。
 *
 * 機密の trust 境界: 断片が secret 系宣言 (`infisical` / `requires_secret` /
 * `cernere_launch_credentials`) を持つと、 任意リポが自分に他サービスの secret を引き込める
 * (trust boundary の拡大)。 これを制御可能かつ可視にするため:
 *   - secret 系宣言を持つ断片は *常に* warn を出す (trust surface を surface する)。
 *   - env `EXCUBITOR_FRAGMENT_SECRET_ALLOWLIST` (カンマ区切りのリポ dir 名) が **設定されると
 *     enforce モード** になり、 allowlist 外のリポの断片からは secret 系宣言を剥がす。
 *   - 未設定時は非破壊 (既存挙動維持) で warn のみ。 厳格化したい運用は allowlist を設定する。
 * secret を確実に扱いたい定義は、 レビュー済みの `catalog/services.yaml` (正本) に置くのが本筋。
 */

import { createHash } from 'node:crypto';
import { type Dirent, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { arsRoot } from '../shared/roots.js';
import { createNamedLogger } from '../shared/logger.js';
import { interpolateRoots } from './interpolate.js';

const logger = createNamedLogger('excubitor.catalog.fragments');

/** 各サービスリポ直下に置く断片ファイル名。 */
export const FRAGMENT_FILENAME = 'excubitor.catalog.yaml';

/** 断片が既定で宣言できない secret 系フィールド (allowlist 外では剥がす)。 */
const SECRET_FIELDS = ['infisical', 'requires_secret', 'cernere_launch_credentials'] as const;

export interface FragmentAggregate {
  /** 集積した生の service エントリ (未検証、 loader が zod で検証する)。 */
  services: unknown[];
  /** 断片を読んだファイルパス (診断用)。 */
  sources: string[];
}

/** forward-slash 正規化 + 末尾スラッシュ除去 (roots.ts と同じ表記に揃える)。 */
function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** 走査ルート一覧 (ARS_ROOT + env 追加分、 重複除去)。 */
export function fragmentRoots(): string[] {
  const roots = [arsRoot()];
  const extra = (process.env.EXCUBITOR_FRAGMENT_DIRS ?? '').trim();
  if (extra) {
    for (const p of extra.split(',').map((s) => s.trim()).filter(Boolean)) {
      roots.push(normalize(p));
    }
  }
  return [...new Set(roots)];
}

interface Discovery {
  /** 実在が確認できた断片ファイル (昇順)。 */
  files: string[];
  /** readdir が一時エラーで列挙できなかったルート (ENOENT = genuine 不在は含めない)。 */
  incompleteRoots: string[];
}

/** ErrnoException の code を取り出す。 */
function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * 各ルート直下の `<child>/excubitor.catalog.yaml` を列挙する。
 * ルートが実在しない (ENOENT) → 静かにスキップ。 それ以外の readdir/stat 失敗は
 * *一時エラー* とみなし、 warn した上で「消えた」扱いにはしない (incompleteRoots に記録)。
 */
function discoverFragments(): Discovery {
  const found: string[] = [];
  const seen = new Set<string>();
  const incompleteRoots: string[] = [];
  for (const root of fragmentRoots()) {
    let entries: Dirent[];
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch (err) {
      if (errCode(err) !== 'ENOENT') {
        // ルートは在るのに読めない (EACCES/EMFILE/EBUSY 等) = 一時エラー。 列挙できないだけで
        // 消えたわけではないので、 このルート配下の last-known-good は保持する。
        incompleteRoots.push(root);
        logger.warn(
          { root, code: errCode(err), err: (err as Error).message },
          'fragment root enumeration failed (transient) — retaining last-known fragments under it',
        );
      }
      continue; // ENOENT: ルートが実在しない → genuine にスキップ
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const file = normalize(join(root, ent.name, FRAGMENT_FILENAME));
      if (seen.has(file)) continue;
      try {
        if (statSync(file).isFile()) {
          seen.add(file);
          found.push(file);
        }
      } catch (err) {
        if (errCode(err) === 'ENOENT') {
          // 断片ファイルが無い/消えた = genuine 不在。 last-known-good を破棄する。
          lastGood.delete(file);
        } else if (lastGood.has(file)) {
          // stat 一時失敗だが直近 good があるので保持する。
          seen.add(file);
          found.push(file);
          logger.warn({ file, code: errCode(err), err: (err as Error).message }, 'fragment stat failed (transient) — retaining');
        }
      }
    }
  }
  return { files: found.sort(), incompleteRoots };
}

/** 各ルート直下の `<child>/excubitor.catalog.yaml` を列挙 (存在するもののみ、 昇順)。 */
export function fragmentFiles(): string[] {
  return discoverFragments().files;
}

/**
 * 新規断片ファイルの出現を検知するために監視すべきディレクトリ群。
 * = 各ルート直下のリポ dir (この中に `excubitor.catalog.yaml` が後から作られたら拾う)。
 * ルート自体も含める (新規リポ dir の出現に反応させるため)。
 */
export function fragmentWatchDirs(): string[] {
  const dirs = new Set<string>();
  for (const root of fragmentRoots()) {
    let entries: Dirent[];
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    dirs.add(root);
    for (const ent of entries) {
      if (ent.isDirectory()) dirs.add(normalize(join(root, ent.name)));
    }
  }
  return [...dirs].sort();
}

interface FragmentParse {
  /** interpolate 後テキストの内容ハッシュ (mtime 非依存の変更検知キー)。 */
  hash: string;
  /** parse 済みの生 service エントリ (sanitize 前)。 */
  services: unknown[];
}
/** file -> 直近の成功 parse。 一時エラー時に保持し、 サービス消滅を防ぐ。 */
const lastGood = new Map<string, FragmentParse>();

interface CacheEntry {
  key: string;
  aggregate: FragmentAggregate;
}
let cache: CacheEntry | null = null;

/**
 * 1 断片を読む。 内容ハッシュが直近 good と一致すれば再 parse しない。
 * read/parse が一時的に失敗したら直近 good を保持して返す (サービスを落とさない)。
 * 断片が実在しない (ENOENT) 場合のみ null を返し last-known-good を破棄する。
 */
function readOneFragment(file: string): FragmentParse | null {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    if (errCode(err) === 'ENOENT') {
      lastGood.delete(file);
      return null;
    }
    logger.warn(
      { file, code: errCode(err), err: (err as Error).message },
      'fragment read failed (transient) — using last-known-good',
    );
    return lastGood.get(file) ?? null;
  }

  const interpolated = interpolateRoots(raw);
  const hash = createHash('sha1').update(interpolated).digest('hex');
  const cached = lastGood.get(file);
  if (cached && cached.hash === hash) return cached;

  try {
    const parsed = load(interpolated) as { services?: unknown } | null;
    const list = Array.isArray(parsed?.services) ? parsed!.services : [];
    const entry: FragmentParse = { hash, services: list };
    lastGood.set(file, entry);
    return entry;
  } catch (err) {
    // 書き込み途中の不完全な YAML 等 = 一時エラー。 直近 good を保持し、 サービスを落とさない。
    logger.warn(
      { file, err: (err as Error).message },
      'fragment parse failed (transient) — retaining last-known-good',
    );
    return cached ?? null;
  }
}

/** `<root>/<repo>/excubitor.catalog.yaml` の `<repo>` (allowlist 判定キー)。 */
function repoNameOf(file: string): string {
  const parts = normalize(file).split('/');
  return parts.length >= 2 ? parts[parts.length - 2]! : '';
}

interface SecretPolicy {
  /** allowlist が設定されている = 非 allowlist リポの secret を剥がす。 */
  enforce: boolean;
  /** secret 宣言を許可するリポ dir 名。 */
  allow: Set<string>;
}

/** secret 系宣言の扱いを env から決める。 allowlist 未設定なら warn のみ (非破壊)。 */
function secretPolicy(): SecretPolicy {
  const raw = (process.env.EXCUBITOR_FRAGMENT_SECRET_ALLOWLIST ?? '').trim();
  const allow = new Set(raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : []);
  return { enforce: allow.size > 0, allow };
}

/**
 * secret 系宣言を持つ断片を可視化し、 enforce モードでは allowlist 外のリポから剥がす。
 * 剥がすときのみ shallow clone する (非該当エントリは参照そのまま = キャッシュ安全)。
 */
function sanitizeSecretFields(entry: unknown, repo: string, policy: SecretPolicy): unknown {
  if (!entry || typeof entry !== 'object') return entry;
  const rec = entry as Record<string, unknown>;
  const present = SECRET_FIELDS.filter((f) => rec[f] !== undefined);
  if (present.length === 0) return entry;
  const allowed = policy.allow.has(repo);
  if (policy.enforce && !allowed) {
    const clone: Record<string, unknown> = { ...rec };
    for (const f of present) delete clone[f];
    logger.warn(
      { repo, code: rec.code, stripped: present },
      'fragment secret-bearing fields stripped (repo not in EXCUBITOR_FRAGMENT_SECRET_ALLOWLIST)',
    );
    return clone;
  }
  // 非 enforce (または allowlist 内) でも secret を持つ断片は trust surface として常に surface する。
  logger.warn(
    { repo, code: rec.code, fields: present, enforced: policy.enforce, allowed },
    'fragment declares secret-bearing fields (trust boundary — set EXCUBITOR_FRAGMENT_SECRET_ALLOWLIST to enforce)',
  );
  return entry;
}

/** incompleteRoots 配下の直近 good を retain 対象へ足す (列挙できなかっただけで消えてない)。 */
function withRetained(files: string[], incompleteRoots: string[]): string[] {
  if (incompleteRoots.length === 0) return files;
  const set = new Set(files);
  for (const file of lastGood.keys()) {
    if (set.has(file)) continue;
    if (incompleteRoots.some((root) => file.startsWith(`${root}/`))) set.add(file);
  }
  return [...set].sort();
}

/**
 * ワークスペース配下の断片を集積する。 走査結果 + 各断片の内容ハッシュ + allowlist が
 * 前回と同一ならキャッシュ (同一オブジェクト) を返す。 変化があれば再集積する。
 */
export function readFragmentServicesRaw(): FragmentAggregate {
  const { files, incompleteRoots } = discoverFragments();
  const targets = withRetained(files, incompleteRoots);
  const policy = secretPolicy();

  // 1st pass: 各断片を読み (内容ハッシュで再 parse を回避)、 signature を作る。
  const parses = new Map<string, FragmentParse | null>();
  const sig: string[] = [`secret:${policy.enforce ? [...policy.allow].sort().join(',') : 'warn'}`];
  for (const file of targets) {
    const parsed = readOneFragment(file);
    parses.set(file, parsed);
    sig.push(parsed ? `${file}:${parsed.hash}` : `${file}:missing`);
  }
  const key = sig.join('|');
  if (cache && cache.key === key) return cache.aggregate;

  // 2nd pass (変化時のみ): sanitize + 集約。 secret 警告もここでのみ出す (定常 reload では黙る)。
  const services: unknown[] = [];
  const sources: string[] = [];
  for (const file of targets) {
    const parsed = parses.get(file);
    if (!parsed || parsed.services.length === 0) continue;
    const repo = repoNameOf(file);
    for (const s of parsed.services) services.push(sanitizeSecretFields(s, repo, policy));
    sources.push(file);
  }
  const aggregate: FragmentAggregate = { services, sources };
  cache = { key, aggregate };
  return aggregate;
}

/** テスト用: 集積キャッシュと per-file good キャッシュを破棄する。 */
export function clearFragmentCache(): void {
  cache = null;
  lastGood.clear();
}
