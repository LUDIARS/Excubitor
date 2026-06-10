/**
 * host プロセススキャン (#91)。
 *
 * runtime=app (ローカルアプリ) は port を持たないため、 死活は「プロセス生存」で見る。
 * Excubitor が自分で spawn したインスタンスは process manager が pid で追跡するが、
 * ユーザが Excubitor 外 (エクスプローラ / スタートメニュー等) から起動した実体は追跡漏れになる。
 * 本モジュールは host の実行中プロセス image 名を列挙し、 catalog の `process_match` と
 * 突き合わせて「外部起動の生存」を検知し、 service_instances の state に反映する。
 *
 * - Excubitor 管理下 (isManaged) のサービスは process manager が真実なので触らない
 * - それ以外で image 一致 → state=running (host_scan 由来) / 不一致 → 直前が host_scan running なら stopped
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { createNamedLogger } from '../shared/logger.js';
import { safeExec } from '../shared/exec.js';
import type { Catalog, Service } from '../catalog/loader.js';
import { isManaged } from '../process/manager.js';

const logger = createNamedLogger('excubitor.host-process');

/**
 * process_match (image 名) と「実行中 image 名集合」を突き合わせ、 一致した code を返す (pure)。
 * 大文字小文字は無視する (Windows の Foo.exe / foo.exe を同一視)。
 */
export function matchProcesses(
  services: Array<Pick<Service, 'code' | 'process_match'>>,
  runningImages: Set<string>,
): Set<string> {
  const lower = new Set(Array.from(runningImages, (s) => s.toLowerCase()));
  const alive = new Set<string>();
  for (const svc of services) {
    if (!svc.process_match) continue;
    if (lower.has(svc.process_match.toLowerCase())) alive.add(svc.code);
  }
  return alive;
}

/** host の実行中プロセス image 名を列挙する。 失敗時は null (= スキャン skip)。 */
export async function listHostProcessImages(): Promise<Set<string> | null> {
  if (process.platform === 'win32') {
    // tasklist /FO CSV /NH → "image","pid",... の CSV。 1 列目が image 名。
    const out = await safeExec('tasklist', ['/FO', 'CSV', '/NH'], process.cwd());
    if (out == null) return null;
    const images = new Set<string>();
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^"([^"]+)"/);
      if (m) images.add(m[1]!);
    }
    return images;
  }
  // POSIX: ps -eo comm= → 各行が実行ファイル名 (basename)。
  const out = await safeExec('ps', ['-eo', 'comm='], process.cwd());
  if (out == null) return null;
  const images = new Set<string>();
  for (const line of out.split(/\r?\n/)) {
    const name = line.trim();
    if (name) images.add(name);
  }
  return images;
}

/** code に対応する service_instances 行を確保し、 state を host_scan 由来で更新する。 */
function setHostScanState(code: string, state: 'running' | 'stopped'): void {
  db().run(sql`
    INSERT INTO service_instances (id, service_id, state, created_at, updated_at)
    SELECT lower(hex(randomblob(16))), s.id, 'pending', unixepoch() * 1000, unixepoch() * 1000
    FROM services s
    WHERE s.code = ${code}
      AND NOT EXISTS (SELECT 1 FROM service_instances si WHERE si.service_id = s.id)
  `);
  db().run(sql`
    UPDATE service_instances
    SET state = ${state},
        last_seen_at = CASE WHEN ${state} = 'running' THEN unixepoch() * 1000 ELSE last_seen_at END,
        updated_at = unixepoch() * 1000
    WHERE service_id IN (SELECT id FROM services WHERE code = ${code})
  `);
}

/**
 * catalog の process_match を持つサービスを host スキャンし、 外部起動の生存を反映する。
 * Excubitor 管理下のサービスは触らない (process manager が真実)。
 * 戻り値: 外部起動として alive と判定した code 数 (テスト/ログ用)。
 */
export async function scanHostProcesses(catalog: Catalog): Promise<{ scanned: number; alive: number }> {
  const targets = catalog.services.filter((s) => s.process_match && !isManaged(s.code));
  if (targets.length === 0) return { scanned: 0, alive: 0 };

  const images = await listHostProcessImages();
  if (images == null) {
    logger.warn('host process listing unavailable — skip host scan');
    return { scanned: targets.length, alive: 0 };
  }

  const aliveCodes = matchProcesses(targets, images);
  for (const svc of targets) {
    setHostScanState(svc.code, aliveCodes.has(svc.code) ? 'running' : 'stopped');
  }
  logger.debug({ scanned: targets.length, alive: aliveCodes.size }, 'host process scan complete');
  return { scanned: targets.length, alive: aliveCodes.size };
}
