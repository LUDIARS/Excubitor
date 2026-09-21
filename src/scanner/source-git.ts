import { dirname } from 'node:path';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type Catalog, type Service } from '../catalog/loader.js';
import { readGitInfo, type GitInfoReader } from './git.js';

/**
 * catalog の cwd を見て service_instances の git 情報だけを更新する。
 *
 * docker scan (`sync.ts`) は docker / docker-compose だけを回すため、 runtime=node 等の
 * サービスは行が作られた当時の branch / hash を持ち続け、 数か月前の値を表示していた
 * (2026-09-19: actio が 7 月の作業ブランチのまま)。 死活 (state) は各 runtime の担当が
 * 決めるので、 ここでは git 列と package_version だけを触る。
 */
export async function syncSourceGitInfo(
  catalog: Catalog,
  readGit: GitInfoReader = readGitInfo,
): Promise<{ updated: number; skipped: number }> {
  let updated = 0;
  let skipped = 0;
  for (const svc of catalog.services) {
    // docker 系は docker scan が state と同時に git を書くので二重に読まない。
    if (svc.runtime === 'docker' || svc.runtime === 'docker-compose') continue;
    const cwd = sourceDirectory(svc);
    if (!cwd) { skipped += 1; continue; }
    const git = await readGit(cwd);
    // 読めなかったときは既知の値を残す (null で上書きして履歴を消さない)。
    if (!git.hash && !git.branch && git.package_version === null) { skipped += 1; continue; }
    updated += writeGitInfo(svc.code, git.branch, git.hash, git.dirty, git.package_version);
  }
  return { updated, skipped };
}

/** catalog が正本。 親ディレクトリを探索して workspace 全体を推測しない (service-version.ts と同じ規則)。 */
function sourceDirectory(svc: Service): string | null {
  if (svc.monitor_only) return null;
  if (svc.cwd) return svc.cwd;
  if (svc.compose_file) return dirname(svc.compose_file);
  if (svc.exec) return dirname(svc.exec);
  if (svc.start_script) return dirname(svc.start_script);
  return null;
}

/**
 * 既存行の git 列だけを更新する。 行が無いときは作らない
 * (state を持たない git 更新が死活の行を発生させないため)。 対象の引き方は
 * disk version の同期 (`version-reconcile.ts`) と同じ service code 経由に揃える。
 */
function writeGitInfo(
  serviceCode: string,
  branch: string | null,
  hash: string | null,
  dirty: boolean | null,
  packageVersion: string | null,
): number {
  // SQLite raw SQL では boolean を 0/1 に変換して書く (sync.ts と同じ)。
  const gitDirty = dirty === null ? null : (dirty ? 1 : 0);
  const result = db().run(sql`
    UPDATE service_instances
    SET git_branch = ${branch},
        git_hash = ${hash},
        git_dirty = ${gitDirty},
        package_version = ${packageVersion},
        updated_at = unixepoch() * 1000
    WHERE service_id IN (SELECT id FROM services WHERE code = ${serviceCode})
  `);
  return result.changes ?? 0;
}
