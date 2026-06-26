/**
 * Corpus 利用設定 (req3)。 各サービスが Corpus を使うかを解決・永続化する。
 *
 * 優先順位: service_prefs (UI 編集の DB override) → catalog の uses_corpus → false。
 * 「Corpus を使うケース / 使わないケースを設定できるようにする」 の中核。
 * orchestrator はこの値が true のサービスを含む起動セットに Corpus を自動で加える。
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { Service, Catalog } from '../catalog/loader.js';

/** Corpus サービスの code (起動セット自動追加の対象)。 */
export const CORPUS_CODE = 'corpus';

/** DB override を code→uses_corpus で取得する (未設定 code は欠落)。 */
export function readCorpusPrefs(): Map<string, boolean> {
  const rows = db().all(sql`
    SELECT code, uses_corpus FROM service_prefs WHERE uses_corpus IS NOT NULL
  `) as Array<{ code: string; uses_corpus: number }>;
  return new Map(rows.map((r) => [r.code, r.uses_corpus === 1]));
}

/** 1 サービスの実効 uses_corpus を解決する。 */
export function effectiveUsesCorpus(svc: Service, prefs: Map<string, boolean>): boolean {
  const override = prefs.get(svc.code);
  if (override !== undefined) return override;
  return svc.uses_corpus ?? false;
}

/** code→実効 uses_corpus の map を作る (UI / orchestrator 用)。 */
export function usesCorpusByCode(catalog: Catalog): Map<string, boolean> {
  const prefs = readCorpusPrefs();
  return new Map(catalog.services.map((s) => [s.code, effectiveUsesCorpus(s, prefs)]));
}

/** UI からの override を保存する (null クリアで catalog デフォルトに戻す)。 */
export function setCorpusPref(code: string, usesCorpus: boolean | null): void {
  if (usesCorpus === null) {
    db().run(sql`DELETE FROM service_prefs WHERE code = ${code}`);
    return;
  }
  db().run(sql`
    INSERT INTO service_prefs (code, uses_corpus, updated_at)
    VALUES (${code}, ${usesCorpus ? 1 : 0}, unixepoch() * 1000)
    ON CONFLICT(code) DO UPDATE SET uses_corpus = excluded.uses_corpus, updated_at = excluded.updated_at
  `);
}

/**
 * 起動セットに Corpus を自動補完する。 選択サービスのいずれかが uses_corpus=true で、
 * かつ Corpus が catalog に存在し未選択なら、 selection に corpus を加えて返す。
 */
export function withCorpusIfNeeded(catalog: Catalog, selection: string[]): string[] {
  const prefs = readCorpusPrefs();
  const want = new Set(selection);
  const anyUsesCorpus = catalog.services.some(
    (s) => want.has(s.code) && effectiveUsesCorpus(s, prefs),
  );
  if (!anyUsesCorpus) return selection;
  const hasCorpus = catalog.services.some((s) => s.code === CORPUS_CODE);
  if (!hasCorpus || want.has(CORPUS_CODE)) return selection;
  return [CORPUS_CODE, ...selection];
}
