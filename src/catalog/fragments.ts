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
 * キャッシュ: 走査で見つかった断片ファイル集合とその mtime をキーにメモリキャッシュし、
 * 変化が無ければ再読込・再パースしない (集積コスト削減 = neco 指示「集積データはキャッシュ」)。
 * 個々の断片は独立に読み、 壊れた 1 ファイルで全体を壊さない。
 */

import { type Dirent, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { arsRoot } from '../shared/roots.js';
import { interpolateRoots } from './interpolate.js';

/** 各サービスリポ直下に置く断片ファイル名。 */
export const FRAGMENT_FILENAME = 'excubitor.catalog.yaml';

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
function fragmentRoots(): string[] {
  const roots = [arsRoot()];
  const extra = (process.env.EXCUBITOR_FRAGMENT_DIRS ?? '').trim();
  if (extra) {
    for (const p of extra.split(',').map((s) => s.trim()).filter(Boolean)) {
      roots.push(normalize(p));
    }
  }
  return [...new Set(roots)];
}

/** 各ルート直下の `<child>/excubitor.catalog.yaml` を列挙 (存在するもののみ、 昇順)。 */
export function fragmentFiles(): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const root of fragmentRoots()) {
    let entries: Dirent[];
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue; // ルートが存在しなければスキップ
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
      } catch {
        // 断片が無いリポはスキップ
      }
    }
  }
  return found.sort();
}

interface CacheEntry {
  key: string;
  aggregate: FragmentAggregate;
}
let cache: CacheEntry | null = null;

/** ファイル集合 + mtime からキャッシュキーを作る。 */
function cacheKey(files: string[]): string {
  return files
    .map((f) => {
      try {
        return `${f}:${statSync(f).mtimeMs}`;
      } catch {
        return `${f}:0`;
      }
    })
    .join('|');
}

/**
 * ワークスペース配下の断片を集積する。 走査結果が前回と同一 (パス集合 + mtime) なら
 * キャッシュを返す。 変化があれば再集積してキャッシュを差し替える。
 */
export function readFragmentServicesRaw(): FragmentAggregate {
  const files = fragmentFiles();
  const key = cacheKey(files);
  if (cache && cache.key === key) return cache.aggregate;

  const services: unknown[] = [];
  const sources: string[] = [];
  for (const file of files) {
    try {
      const parsed = load(interpolateRoots(readFileSync(file, 'utf8'))) as { services?: unknown } | null;
      const list = Array.isArray(parsed?.services) ? parsed!.services : [];
      if (list.length > 0) {
        for (const s of list) services.push(s);
        sources.push(file);
      }
    } catch {
      // パース失敗した 1 断片は握りつぶす (他の断片は活かす)。
    }
  }

  const aggregate: FragmentAggregate = { services, sources };
  cache = { key, aggregate };
  return aggregate;
}

/** テスト用: 集積キャッシュを破棄する。 */
export function clearFragmentCache(): void {
  cache = null;
}
