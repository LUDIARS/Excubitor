/**
 * boot 時のプロセス状態の再構築 (永続化された service_instances と実プロセスの突合)。
 *
 * Excubitor は子サービスを detached で起動するため、 Excubitor 自身が再起動しても
 * サービスは生き続ける。 boot 時に DB に残った running/pending な node/dev-process-md
 * インスタンスと、spawn 失敗時に生存 pid を保持した crashed インスタンスを生存確認し:
 *   - 生存 → adoptProcess() で再採用 (stop 可能・状態は running 維持)
 *   - 死亡 → state を crashed に落とす (stale な running を解消)
 *
 * docker サービスは scanner が別途実体と同期するため対象外。
 */

import { sql } from 'drizzle-orm';
import { createNamedLogger } from '../shared/logger.js';
import { db } from '../db/client.js';
import type { Catalog } from '../catalog/loader.js';
import { managedPortsForService } from '../catalog/ports.js';
import { adoptProcess, getManagedPid, isManaged, isPidAlive, isPidManaged } from './manager.js';
import { readProcessIdentity, verifyProcessIdentity, type VerifiedProcessIdentity } from './identity.js';
import { listListeners } from '../scanner/ports.js';

const logger = createNamedLogger('excubitor.process.reconcile');

interface PersistedInstance {
  code: string;
  pid: number | null;
  state: string;
  started_at: number | null;
}

export interface ReconcileResult {
  adopted: string[];
  crashed: string[];
  /** 記録が無いまま宣言ポートで稼働していて、pid 突合で拾い直したサービス。 */
  adoptedByPort: string[];
}

/**
 * node / dev-process-md / app のうち、DB 上 running/pending な行と、spawn 失敗時に
 * 生存 PID を保持した行を実プロセスと突合する。
 */
export async function reconcileProcesses(catalog: Catalog): Promise<ReconcileResult> {
  const processRuntimes = new Set(
    catalog.services
      .filter((s) => s.runtime === 'node' || s.runtime === 'dev-process-md' || s.runtime === 'app')
      .map((s) => s.code),
  );

  const rows = db().all(sql`
    SELECT s.code AS code, si.pid AS pid, si.state AS state, si.started_at AS started_at
    FROM service_instances si
    JOIN services s ON s.id = si.service_id
    WHERE si.state IN ('running', 'pending')
       OR (si.state = 'crashed' AND si.pid IS NOT NULL)
  `) as PersistedInstance[];

  const result: ReconcileResult = { adopted: [], crashed: [], adoptedByPort: [] };

  for (const row of rows) {
    if (!processRuntimes.has(row.code)) continue; // docker 等は scanner 任せ
    const expectedStartedAt = row.started_at ? new Date(row.started_at) : null;
    const identity = row.pid && expectedStartedAt && isPidAlive(row.pid)
      ? await verifyProcessIdentity(row.pid, expectedStartedAt)
      : null;
    if (identity && (!isPidManaged(identity.pid) || getManagedPid(row.code) === identity.pid)) {
      // Persist before publishing the in-memory adoption so DB/UI state cannot remain
      // crashed or pending while lifecycle commands already treat the process as running.
      persistAdoptedIdentity(row.code, identity);
      adoptProcess(row.code, identity);
      result.adopted.push(row.code);
    } else {
      db().run(sql`
        UPDATE service_instances
        SET state = 'crashed', pid = NULL, updated_at = unixepoch() * 1000
        WHERE service_id IN (SELECT id FROM services WHERE code = ${row.code})
      `);
      result.crashed.push(row.code);
    }
  }

  await adoptDeclaredPortOwners(catalog, processRuntimes, result);

  if (result.adopted.length || result.crashed.length || result.adoptedByPort.length) {
    logger.info(result, 'reconciled persisted process instances');
  }
  return result;
}

/**
 * 記録に無いまま宣言ポートで動いているサービスを pid で拾い直す。
 *
 * 永続 pid の突合だけでは、**記録そのものが失われた実体**を取り戻せない。 起動時の identity
 * 照合が失敗すると `recordSpawnFailure` が pid を捨てて `crashed` にするため、実プロセスが
 * 生き残っていても Excubitor は以後ずっと「停止中」と信じ続ける (2026-08-10 concordia:
 * Excubitor は stopped / pid=null、実体は 11111 を保持して稼働)。 そうなると停止も再起動も
 * 到達できず、次の起動は EADDRINUSE でしか失敗を知らせない。
 *
 * サービスが宣言したポートを握っている生存 pid は、そのサービスの実体として扱う — 実体で
 * ないなら、それは起動を妨げる占有として同じく Excubitor が把握すべきものになる。 いずれにせよ
 * 「知らない」まま放置してよい pid ではない。
 */
export interface PortAdoptionDeps {
  listeners: () => Promise<Array<{ port: number; pids: number[] }>>;
  isAlive: (pid: number) => boolean;
  identity: (pid: number) => Promise<VerifiedProcessIdentity | null>;
  adopt: (code: string, identity: VerifiedProcessIdentity) => void;
  managed: (code: string) => boolean;
  pidManaged: (pid: number) => boolean;
  persist: (code: string, identity: VerifiedProcessIdentity) => void;
}

const DEFAULT_PORT_ADOPTION_DEPS: PortAdoptionDeps = {
  listeners: listListeners,
  isAlive: isPidAlive,
  identity: readProcessIdentity,
  adopt: adoptProcess,
  managed: isManaged,
  pidManaged: isPidManaged,
  persist: persistAdoptedIdentity,
};

function persistAdoptedIdentity(code: string, identity: VerifiedProcessIdentity): void {
  const startedAt = identity.startedAt.getTime();
  db().run(sql`
    INSERT INTO service_instances (id, service_id, state, created_at, updated_at)
    SELECT lower(hex(randomblob(16))), s.id, 'pending', unixepoch() * 1000, unixepoch() * 1000
    FROM services s
    WHERE s.code = ${code}
      AND NOT EXISTS (SELECT 1 FROM service_instances si WHERE si.service_id = s.id)
  `);
  db().run(sql`
    UPDATE service_instances
    SET state = 'running',
        pid = ${identity.pid},
        started_at = ${startedAt},
        last_seen_at = unixepoch() * 1000,
        updated_at = unixepoch() * 1000
    WHERE service_id IN (SELECT id FROM services WHERE code = ${code})
  `);
}

export async function adoptDeclaredPortOwners(
  catalog: Catalog,
  processRuntimes: Set<string>,
  result: ReconcileResult,
  deps: PortAdoptionDeps = DEFAULT_PORT_ADOPTION_DEPS,
): Promise<void> {
  const candidates = portAdoptionCandidates(catalog, processRuntimes, deps.managed);
  if (candidates.length === 0) return;

  let listeners;
  try {
    listeners = await deps.listeners();
  } catch (error) {
    // ポート走査は補助手段。 読めなくても通常の pid 突合の結果は返す。
    logger.warn({ err: (error as Error).message }, 'could not scan listeners while reconciling');
    return;
  }

  const adoptedCodes = new Set<string>();
  const adoptedPids = new Set<number>();
  for (const service of candidates) {
    if (adoptedCodes.has(service.code) || deps.managed(service.code)) continue;
    const listener = listeners.find((entry) => entry.port === service.port);
    const pid = soleLivePid(listener?.pids ?? [], deps.isAlive);
    // Multiple live owners are ambiguous (for example SO_REUSEPORT). Choosing the first
    // would grant stop/restart authority over an arbitrary process.
    if (pid === null || adoptedPids.has(pid) || deps.pidManaged(pid)) continue;
    let identity: VerifiedProcessIdentity | null;
    try {
      identity = await deps.identity(pid);
    } catch (error) {
      logger.warn(
        { code: service.code, pid, err: (error as Error).message },
        'could not read listener identity while reconciling',
      );
      continue;
    }
    if (
      !identity
      || identity.pid !== pid
      || Number.isNaN(identity.startedAt.getTime())
      // Listener and identity reads are asynchronous. Do not overwrite a service that
      // another lifecycle request placed under management while those reads were in flight.
      || deps.managed(service.code)
      || deps.pidManaged(pid)
    ) continue;
    let stillOwnsPort = false;
    try {
      const refreshedListeners = await deps.listeners();
      stillOwnsPort = refreshedListeners.some(
        (entry) => entry.port === service.port && entry.pids.includes(pid),
      );
    } catch (error) {
      logger.warn(
        { code: service.code, pid, err: (error as Error).message },
        'could not confirm listener ownership while reconciling',
      );
      continue;
    }
    // The original listener scan can become stale while process identity is read. Requiring
    // the same PID to own the same port again avoids adopting a recycled PID that never held it.
    if (
      !stillOwnsPort
      || !deps.isAlive(pid)
      || deps.managed(service.code)
      || deps.pidManaged(pid)
      || adoptedPids.has(pid)
    ) continue;
    // Persist first so a failed DB write cannot leave an in-memory adoption that disappears
    // on the next supervisor restart. Both operations are synchronous, so no lifecycle
    // request can interleave between this final managed check and adoption.
    deps.persist(service.code, identity);
    deps.adopt(service.code, identity);
    adoptedCodes.add(service.code);
    adoptedPids.add(pid);
    logger.warn(
      { code: service.code, pid, port: service.port },
      'adopted a running service that had no usable pid record (see design.md §17.4.3)',
    );
    result.adoptedByPort.push(service.code);
  }
}

function portAdoptionCandidates(
  catalog: Catalog,
  processRuntimes: Set<string>,
  isManagedService: (code: string) => boolean,
): Array<{ code: string; port: number }> {
  const declarationsByPort = new Map<number, Set<string>>();
  for (const service of catalog.services) {
    if (!processRuntimes.has(service.code)) continue;
    for (const declaration of managedPortsForService(service)) {
      const codes = declarationsByPort.get(declaration.port) ?? new Set<string>();
      codes.add(service.code);
      declarationsByPort.set(declaration.port, codes);
    }
  }
  return catalog.services.flatMap((service) => {
    if (!processRuntimes.has(service.code) || isManagedService(service.code)) return [];
    return managedPortsForService(service)
      // A listener cannot identify which service owns a port declared by more than one
      // catalog entry. Adopting it under an arbitrary code would grant stop/restart
      // authority over the wrong service.
      .filter((declaration) => declarationsByPort.get(declaration.port)?.size === 1)
      .map((declaration) => ({ code: service.code, port: declaration.port }));
  });
}

function soleLivePid(pids: number[], isAlive: (pid: number) => boolean): number | null {
  const livePids = [...new Set(pids.filter((pid) => isAlive(pid)))];
  return livePids.length === 1 ? livePids[0]! : null;
}
