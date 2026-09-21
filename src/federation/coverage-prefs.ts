/**
 * 拠点ごとの担保上書き (federation_coverage_prefs) の読み書き。
 *
 * 行が無い code は catalog の既定 (= 自拠点の catalog に載っていれば担保) に従う。
 * null を保存すると行を消し、 既定に戻す。
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

/** @implements SPEC-FEDERATION-COVERAGE */

/** code → covered の上書き一覧 (未設定 code は欠落)。 */
export function readCoveragePrefs(): Map<string, boolean> {
  const rows = db().all(sql`SELECT code, covered FROM federation_coverage_prefs`) as Array<{
    code: string;
    covered: number;
  }>;
  return new Map(rows.map((r) => [r.code, Number(r.covered) === 1]));
}

export function setCoveragePref(code: string, covered: boolean | null): void {
  if (covered === null) {
    db().run(sql`DELETE FROM federation_coverage_prefs WHERE code = ${code}`);
    return;
  }
  db().run(sql`
    INSERT INTO federation_coverage_prefs (code, covered, updated_at)
    VALUES (${code}, ${covered ? 1 : 0}, unixepoch() * 1000)
    ON CONFLICT(code) DO UPDATE SET covered = excluded.covered, updated_at = excluded.updated_at
  `);
}
