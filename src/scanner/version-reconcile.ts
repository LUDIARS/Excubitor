/**
 * 「ディスクに置かれている版」と「走っているプロセスが名乗る版」の突き合わせ。
 *
 * Excubitor は起動時に `EXCUBITOR_SERVICE_VERSION` (= catalog cwd から解決した
 * 版) を子プロセスへ注入する (process/service-version.ts, SPEC-SERVICE-RUNTIME-VERSION)。
 * サービスはそれを health の `version` として名乗り返す (AIFormat `RULE_SRE.md` §2)。
 *
 * したがって両者の食い違いは 「起動後にディスクが進んだ」 = **再起動しないと反映
 * されない / 再起動したつもりで旧コードを掴んだまま** を意味する。 health が 200 を
 * 返していても中身が古い、 という最も気づきにくい事故をここで可視化する。
 *
 * @implements SPEC-SERVICE-RUNTIME-VERSION
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { Catalog } from '../catalog/loader.js';
import { resolveServiceRuntimeVersion } from '../process/service-version.js';
import { resolveBuildVersion } from '../shared/build-version.js';
import { createNamedLogger } from '../shared/logger.js';

const logger = createNamedLogger('excubitor.version-reconcile');

export type VersionReconcileStatus = 'match' | 'mismatch' | 'unknown';

const UNRESOLVED_VERSIONS = new Set(['unknown', '0.0.0+unversioned']);

/**
 * 突き合わせ結果。 どちらかが欠けている間は `unknown` であって `mismatch` ではない
 * (版を名乗らないサービスを 「壊れている」 と誤報しない)。
 */
export function reconcileStatus(
  diskVersion: string | null | undefined,
  reportedVersion: string | null | undefined,
): VersionReconcileStatus {
  const disk = normalize(diskVersion);
  const reported = normalize(reportedVersion);
  if (!disk || !reported) return 'unknown';
  // 版を解決できなかった明示マーカー同士を、根拠のある一致として扱わない。
  if (UNRESOLVED_VERSIONS.has(disk) || UNRESOLVED_VERSIONS.has(reported)) return 'unknown';
  return disk === reported ? 'match' : 'mismatch';
}

function normalize(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * catalog の各サービスについてディスク上の版を解決し、 service_instances へ記録する。
 *
 * 管理対象サービスは起動時に注入する値と同じ resolver を使う。Excubitor 自身だけは
 * boot 時に公開する build version と同じ resolver を使い、異なる版体系を比べて偽の
 * mismatch にしない。git / package.json を読むため health 走査 (5 分間隔) と同じ周期で
 * 回し、それ以上の頻度では呼ばない。
 */
export async function syncDiskVersions(catalog: Catalog): Promise<{ updated: number }> {
  let updated = 0;
  for (const svc of catalog.services) {
    if (svc.monitor_only) continue;
    let version: string;
    try {
      if (svc.code === 'excubitor') {
        version = (await resolveBuildVersion(catalog, 'excubitor', process.cwd()))?.version
          ?? '0.0.0+unversioned';
      } else {
        version = (await resolveServiceRuntimeVersion(svc)).value;
      }
    } catch (err) {
      logger.warn({ code: svc.code, err: (err as Error).message }, 'disk version resolve failed');
      continue;
    }
    const result = db().run(sql`
      UPDATE service_instances
      SET disk_version = ${version},
          updated_at = unixepoch() * 1000
      WHERE service_id IN (SELECT id FROM services WHERE code = ${svc.code})
    `);
    updated += result.changes ?? 0;
  }
  return { updated };
}
