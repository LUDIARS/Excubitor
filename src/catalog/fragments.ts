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
 * キャッシュ: 走査で見つかった断片ファイル集合とその mtime/ctime/size をキーにメモリ
 * キャッシュし、 変化が無ければ再読込・再パースしない (集積コスト削減 = neco 指示
 * 「集積データはキャッシュ」)。 個々の断片は独立に読み、 壊れた 1 ファイルで全体を壊さない。
 *
 * 信頼境界: 断片は ARS_ROOT 配下の任意リポに置けるため、 secret を要求する宣言
 * (`infisical` / `requires_secret` / `cernere_launch_credentials`) は allowlist
 * (env `EXCUBITOR_FRAGMENT_SECRET_ALLOWLIST`) に列挙されたリポの断片からのみ honor する。
 * allowlist 外の断片は非 secret 定義 (port / topology / health) だけ集積し、 secret 宣言は
 * 剥がして warn する (任意リポが自分を secret 要求サービスとして登録するのを防ぐ)。
 *
 * 一時障害の扱い: 断片の enumerate / read / parse が一時的に失敗しても、 それを
 * 「サービス削除」と同一視しない。 ENOENT (本当に消えた) のみ削除とし、 それ以外の失敗は
 * 直近の正常値 (last-known-good) を保持して loud に warn する。 一瞬の hiccup で登録済み
 * サービスが無言でカタログから消えるのを防ぐ。
 */

import { type Dirent, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { arsRoot } from '../shared/roots.js';
import { createNamedLogger } from '../shared/logger.js';
import { interpolateRoots } from './interpolate.js';

const logger = createNamedLogger('excubitor.catalog.fragments');

/** 各サービスリポ直下に置く断片ファイル名。 */
export const FRAGMENT_FILENAME = 'excubitor.catalog.yaml';

/**
 * allowlist されていない断片から剥がす secret 要求フィールド。
 * これらは他サービスの infisical project から secret を借りたり、 自分の secret 注入を
 * 要求したりする「信頼を要する宣言」。 任意リポが宣言するだけで通ってはいけない。
 */
const SECRET_DECL_FIELDS = ['infisical', 'requires_secret', 'cernere_launch_credentials'] as const;

export interface FragmentAggregate {
  /** 集積した生の service エントリ (未検証、 loader が zod で検証する)。 */
  services: unknown[];
  /** services[i] が来た断片ファイルのパス (index 対応、 診断/検証エラー通知用)。 */
  serviceSources: string[];
  /** 断片を読んだファイルパス (>=1 サービスを寄与したファイル、 診断用)。 */
  sources: string[];
}

/** forward-slash 正規化 + 末尾スラッシュ除去 (roots.ts と同じ表記に揃える)。 */
function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** ENOENT (本当に存在しない) 以外の fs エラーは一時障害 (transient) とみなす。 */
function isTransientFsError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  // ENOENT のみ「本当に消えた」。 EACCES/EMFILE/ENFILE/EBUSY/EIO/EPERM/ELOOP/ENOTDIR 等は
  // 一時的な hiccup として扱い、 登録済み断片を消さない。
  return code !== undefined && code !== 'ENOENT';
}

/** 断片ファイルパスから所属リポ名 (`<root>/<repo>/excubitor.catalog.yaml` の <repo>) を取る。 */
function repoNameOf(file: string): string {
  const parts = normalize(file).split('/');
  return parts.length >= 2 ? parts[parts.length - 2] : '';
}

/** secret 宣言を honor してよいリポ名の allowlist (env、 カンマ区切り)。 */
function fragmentSecretAllowlist(): Set<string> {
  const raw = (process.env.EXCUBITOR_FRAGMENT_SECRET_ALLOWLIST ?? '').trim();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * allowlist 外の断片から secret 要求フィールドを剥がす。
 * サービス自体 (port / health / topology) は登録するが、 secret を引き出す宣言は無視する。
 * base catalog (`catalog/services.yaml`) は Excubitor リポにコミット/レビューされる正本で
 * 信頼するのに対し、 断片は任意リポ由来なので secret 宣言だけは明示 allowlist を要求する。
 */
function stripUntrustedSecretDecls(services: unknown[], file: string, allow: Set<string>): unknown[] {
  const repo = repoNameOf(file);
  if (allow.has(repo)) return services; // 明示 allowlist 済み → 宣言をそのまま信頼
  return services.map((entry) => {
    if (!entry || typeof entry !== 'object') return entry;
    const rec = entry as Record<string, unknown>;
    const present = SECRET_DECL_FIELDS.filter((f) => rec[f] !== undefined);
    if (present.length === 0) return entry;
    logger.warn(
      { file, repo, code: rec.code, stripped: present },
      'allowlist 外の断片が secret 宣言を含む → 無視 (信頼境界の保護)。' +
        '許可するには EXCUBITOR_FRAGMENT_SECRET_ALLOWLIST にリポ名を追加する',
    );
    const clone: Record<string, unknown> = { ...rec };
    for (const f of present) delete clone[f];
    return clone;
  });
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

/**
 * 直近に正常パースできた断片の services (sanitize 済み)。
 * enumerate/read/parse の一時失敗時に「登録済みサービスを消さない」ための last-known-good。
 */
const lastGood = new Map<string, unknown[]>();

/** 各ルート直下の `<child>/excubitor.catalog.yaml` を列挙 (存在するもののみ、 昇順)。 */
export function fragmentFiles(): string[] {
  const found = new Set<string>();
  for (const root of fragmentRoots()) {
    let entries: Dirent[];
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch (err) {
      if (isTransientFsError(err)) {
        // ルートの列挙に一時失敗 → そのルート配下の既知断片を保持 (無言で全部消さない)。
        logger.warn(
          { root, err: (err as Error).message, code: (err as NodeJS.ErrnoException).code },
          'fragment root の列挙に一時失敗 → 既知の断片を保持',
        );
        for (const known of lastGood.keys()) {
          if (known.startsWith(`${root}/`)) found.add(known);
        }
      }
      // ENOENT: ルートが存在しないだけ → スキップ
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const file = normalize(join(root, ent.name, FRAGMENT_FILENAME));
      if (found.has(file)) continue;
      try {
        if (statSync(file).isFile()) found.add(file);
      } catch (err) {
        if (isTransientFsError(err)) {
          // stat の一時失敗 → 既知なら保持 (削除扱いにしない)。
          logger.warn(
            { file, err: (err as Error).message, code: (err as NodeJS.ErrnoException).code },
            'fragment の stat に一時失敗 → 既知なら保持',
          );
          if (lastGood.has(file)) found.add(file);
        }
        // ENOENT: 断片が無いリポはスキップ
      }
    }
  }
  return [...found].sort();
}

/**
 * 各ルート直下のディレクトリ (= 断片を持ちうるリポ dir) を列挙する。
 * watcher が「まだ断片を持たないリポに新規 excubitor.catalog.yaml が現れる」ケースを
 * 検知するため、 断片の有無に関わらず全 child dir を対象にする (filename フィルタと併用)。
 */
export function fragmentRepoDirs(): string[] {
  const dirs = new Set<string>();
  for (const root of fragmentRoots()) {
    let entries: Dirent[];
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue; // ルート不在/一時失敗 → 監視対象 dir は列挙できない (watcher 側は roots も張る)
    }
    for (const ent of entries) {
      if (ent.isDirectory()) dirs.add(normalize(join(root, ent.name)));
    }
  }
  return [...dirs].sort();
}

interface CacheEntry {
  key: string;
  aggregate: FragmentAggregate;
}
let cache: CacheEntry | null = null;

/**
 * 断片 1 ファイルの内容シグネチャ。 mtime に加え ctime / size も含めることで、
 * mtime を保持したままの内容変更 (バックアップ/git checkout での復元 → ctime 変化、
 * 長さの変わる編集 → size 変化) も検知する。 全て同一 statSync 呼び出しから取れるため
 * 追加 I/O は無い (= キャッシュの目的を損なわない)。
 */
function signatureOf(file: string): string {
  try {
    const st = statSync(file);
    return `${file}:${st.mtimeMs}:${st.ctimeMs}:${st.size}`;
  } catch {
    return `${file}:missing`;
  }
}

/** ファイル集合 + 各内容シグネチャからキャッシュキーを作る。 */
function cacheKey(files: string[]): string {
  return files.map(signatureOf).join('|');
}

/**
 * 現在の断片集合のシグネチャ。 watcher が polling フォールバックで変化検知に使う。
 */
export function fragmentSignature(): string {
  return cacheKey(fragmentFiles());
}

/**
 * ワークスペース配下の断片を集積する。 走査結果が前回と同一 (パス集合 + シグネチャ) なら
 * キャッシュを返す。 変化があれば再集積してキャッシュを差し替える。
 *
 * 読込/parse が一時的に失敗した断片は、 last-known-good があればそれを保持する
 * (登録済みサービスを一瞬の hiccup で消さない)。 ENOENT (本当に消えた) のみ削除扱い。
 */
export function readFragmentServicesRaw(): FragmentAggregate {
  const files = fragmentFiles();
  const key = cacheKey(files);
  if (cache && cache.key === key) return cache.aggregate;

  const allow = fragmentSecretAllowlist();
  const services: unknown[] = [];
  const serviceSources: string[] = [];
  const sources: string[] = [];
  const liveFiles = new Set(files);

  for (const file of files) {
    let list: unknown[];
    try {
      const parsed = load(interpolateRoots(readFileSync(file, 'utf8'))) as { services?: unknown } | null;
      const rawList = Array.isArray(parsed?.services) ? parsed!.services : [];
      list = stripUntrustedSecretDecls(rawList, file, allow);
      lastGood.set(file, list); // 正常パース → last-known-good を更新
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // 列挙後・読込前に消えた → 本当に削除。 last-known-good も破棄。
        lastGood.delete(file);
        list = [];
      } else {
        // 一時的な read エラー or YAML parse エラー → last-known-good を保持して loud に warn。
        const prev = lastGood.get(file);
        if (prev) {
          logger.warn(
            { file, err: (err as Error).message, code },
            'fragment の読込/parse に一時失敗 → 直近の正常値を保持 (登録済みサービスを消さない)',
          );
          list = prev;
        } else {
          logger.warn(
            { file, err: (err as Error).message, code },
            'fragment の読込/parse に失敗 (直近の正常値なし) → この断片をスキップ',
          );
          list = [];
        }
      }
    }
    if (list.length > 0) {
      for (const s of list) {
        services.push(s);
        serviceSources.push(file);
      }
      sources.push(file);
    }
  }

  // 本当に消えた断片 (現在の集合に無い) の last-known-good を掃除する。
  // 一時障害中のファイルは fragmentFiles() が保持するため liveFiles に残り、 消えない。
  for (const known of [...lastGood.keys()]) {
    if (!liveFiles.has(known)) lastGood.delete(known);
  }

  const aggregate: FragmentAggregate = { services, serviceSources, sources };
  cache = { key, aggregate };
  return aggregate;
}

/** テスト用: 集積キャッシュと last-known-good を破棄する。 */
export function clearFragmentCache(): void {
  cache = null;
  lastGood.clear();
}
