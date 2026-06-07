/**
 * ProcessManager  Eruntime=node / dev-process-md のサービスめEExcubitor server から
 * spawn して監視する、E
 *
 * v0.1 (this file) でめE��こと:
 *   - spawn (env injection 対忁E
 *   - stdout / stderr の line バッファリング + line-by-line ハンドラ
 *   - exit 検知 + restart_policy 適用
 *   - 状態を service_instances チE�Eブルに反映
 *
 * spawn 出力�Eログ蓁E��E(process_logs チE�Eブル) と error detector は別 module で、E
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createNamedLogger } from '../shared/logger.js';
import { db } from '../db/client.js';
import type { Service } from '../catalog/loader.js';
import { resolveDevProcessCommand } from './dev-process-md.js';
import { execCapture } from '../shared/exec.js';

const logger = createNamedLogger('excubitor.process');

export interface SpawnedProcess {
  code: string;
  child: ChildProcess;
  startedAt: Date;
  restartCount: number;
}

type LineHandler = (svc: Service, channel: 'stdout' | 'stderr', line: string) => void;

const processes = new Map<string, SpawnedProcess>();

/**
 * adopted: Excubitor 再起動前に detached で起動され、 boot 時に pid 生存確認で
 * 「再採用」 したサービス。 ChildProcess は持てない (再取得不可) ので pid のみ保持。
 * stop は pid kill、 ライブログは取れない (file-tail / Vg があればそちらで継続)。
 */
interface AdoptedProcess {
  code: string;
  pid: number;
  startedAt: Date;
}
const adopted = new Map<string, AdoptedProcess>();
const lineHandlers = new Set<LineHandler>();

/** boot 再採用: 既に detached で動いている pid を Excubitor の管理下に戻す。 */
export function adoptProcess(code: string, pid: number, startedAt: Date): void {
  if (processes.has(code)) return; // 自前 spawn が優先
  adopted.set(code, { code, pid, startedAt });
}

/** code が (自前 spawn or 再採用で) 管理下にあるか。 */
export function isManaged(code: string): boolean {
  return processes.has(code) || adopted.has(code);
}

/** pid が生存しているか (signal 0)。 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function registerLineHandler(handler: LineHandler): () => void {
  lineHandlers.add(handler);
  return () => lineHandlers.delete(handler);
}

export function getRunningProcess(code: string): SpawnedProcess | undefined {
  return processes.get(code);
}

export function listRunningProcesses(): SpawnedProcess[] {
  return Array.from(processes.values());
}

export interface SpawnOptions {
  /** env を上書ぁE(secret secret inject 筁E、Eprocess.env にマ�Eジされる、E*/
  env?: Record<string, string>;
  /** restart_policy / max_restart は service catalog 値を使ぁE��、E外部から渡しても良ぁE��E*/
  restartPolicy?: 'no' | 'on-failure' | 'always';
  maxRestart?: number;
  /** 以前�E restartCount を引き継いで spawn する (restart のため)、E*/
  initialRestartCount?: number;
}

export async function spawnService(svc: Service, opts: SpawnOptions = {}): Promise<SpawnedProcess> {
  if (processes.has(svc.code)) {
    throw new Error(`service ${svc.code} is already spawned`);
  }
  if (svc.runtime !== 'node' && svc.runtime !== 'dev-process-md') {
    throw new Error(`spawnService: unsupported runtime ${svc.runtime}`);
  }
  if (!svc.cwd) {
    throw new Error(`service ${svc.code} has no cwd`);
  }

  let cmd: string;
  let args: string[];
  if (svc.runtime === 'node') {
    if (!svc.command) throw new Error(`service ${svc.code} has no command`);
    const parts = splitCommand(svc.command);
    const first = parts.shift();
    if (!first) throw new Error(`service ${svc.code} command is empty`);
    cmd = first;
    args = parts;
  } else {
    // dev-process-md
    const parsed = await resolveDevProcessCommand(svc.cwd);
    const parts = splitCommand(parsed);
    const first = parts.shift();
    if (!first) throw new Error(`service ${svc.code} command is empty`);
    cmd = first;
    args = parts;
  }

  const child = spawn(cmd, args, {
    cwd: svc.cwd,
    shell: true, // Windows での npm 等の解決を簡単にするため shell 経由
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
    // detached: Excubitor 自身が再起動/停止してもサービスを道連れにしない
    // (= 監視コアの状態がサービスに影響しない)。 boot 時に pid で再採用する。
    detached: true,
  });
  // 親 (Excubitor) の event loop を子に縛られないよう unref。 stdout/stderr は
  // 生存中のみライブ取得し、 Excubitor 再起動後はストリーム欠落を許容する。
  child.unref();

  // adopted 側に同 code が残っていれば、 自前 spawn が真実なので除去。
  adopted.delete(svc.code);
  const restartCount = opts.initialRestartCount ?? 0;
  const spawned: SpawnedProcess = { code: svc.code, child, startedAt: new Date(), restartCount };
  processes.set(svc.code, spawned);
  logger.info({ code: svc.code, pid: child.pid, restartCount }, 'spawned (detached)');

  attachLineReader(svc, child, 'stdout');
  attachLineReader(svc, child, 'stderr');

  await updateState(svc.code, 'running', child.pid ?? null);

  child.on('exit', (code, signal) => {
    processes.delete(svc.code);
    logger.info(
      { code: svc.code, exit_code: code, signal, restartCount },
      'process exited',
    );
    void onExit(svc, code, signal, restartCount, opts);
  });

  child.on('error', (err) => {
    logger.error({ code: svc.code, err: err.message }, 'child error');
  });

  return spawned;
}

export async function killService(code: string, signal: NodeJS.Signals = 'SIGTERM'): Promise<boolean> {
  const p = processes.get(code);
  if (p) {
    const pid = p.child.pid;
    if (pid && process.platform === 'win32') {
      // detached + shell:true は子ツリー (cmd → node → ...) になるため、
      // child.kill では shell しか落ちない。 taskkill /T でツリーごと終了。
      await treeKill(pid);
    } else {
      try { p.child.kill(signal); } catch { /* noop */ }
      setTimeout(() => {
        if (processes.has(code)) {
          try { p.child.kill('SIGKILL'); } catch { /* noop */ }
        }
      }, 5000);
    }
    return true;
  }
  // 再採用したサービス: ChildProcess を持たないので pid で kill。
  const a = adopted.get(code);
  if (a) {
    await treeKill(a.pid);
    adopted.delete(code);
    await updateState(code, 'stopped', null, 0);
    return true;
  }
  return false;
}

/** pid のプロセスツリーを終了する (Windows=taskkill /T /F、 他=SIGTERM→SIGKILL)。 */
async function treeKill(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await execCapture('taskkill', ['/PID', String(pid), '/T', '/F'], process.cwd(), 10000);
    return;
  }
  try { process.kill(pid, 'SIGTERM'); } catch { /* noop */ }
  setTimeout(() => {
    if (isPidAlive(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* noop */ }
    }
  }, 5000);
}

async function onExit(
  svc: Service,
  code: number | null,
  signal: NodeJS.Signals | null,
  prevRestartCount: number,
  opts: SpawnOptions,
): Promise<void> {
  const policy = opts.restartPolicy ?? svc.restart_policy;
  const max = opts.maxRestart ?? svc.max_restart;
  const cleanExit = code === 0 && !signal;

  await updateState(svc.code, cleanExit ? 'stopped' : 'crashed', null, code ?? undefined);

  const shouldRestart =
    (policy === 'always') ||
    (policy === 'on-failure' && !cleanExit);

  if (!shouldRestart) return;

  if (prevRestartCount + 1 > max) {
    logger.warn(
      { code: svc.code, restartCount: prevRestartCount + 1, max },
      'restart limit reached  Eopening error_task',
    );
    await raiseRestartLimitError(svc, code ?? -1, signal, max);
    return;
  }

  // exponential backoff: 1s, 2s, 4s, ...
  const delay = Math.min(30_000, 1000 * 2 ** prevRestartCount);
  setTimeout(() => {
    void spawnService(svc, {
      ...opts,
      initialRestartCount: prevRestartCount + 1,
    }).catch((err: unknown) =>
      logger.error({ code: svc.code, err: (err as Error).message }, 'auto-restart failed'),
    );
  }, delay);
}

function attachLineReader(svc: Service, child: ChildProcess, channel: 'stdout' | 'stderr'): void {
  const stream = child[channel];
  if (!stream) return;
  let buf = '';
  stream.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line.length > 0) emitLine(svc, channel, line);
    }
  });
  stream.on('end', () => {
    if (buf.length > 0) {
      emitLine(svc, channel, buf);
      buf = '';
    }
  });
}

function emitLine(svc: Service, channel: 'stdout' | 'stderr', line: string): void {
  for (const h of lineHandlers) {
    try { h(svc, channel, line); } catch (err) {
      logger.warn({ err: (err as Error).message }, 'lineHandler threw');
    }
  }
}

function splitCommand(input: string): string[] {
  // ナイーチEsplit; quote 冁E�Eスペ�Eスは未対応、Ecatalog で sensible な command を書く前提、E
  return input.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((s) => s.replace(/^"|"$/g, '')) ?? [input];
}

async function updateState(
  code: string,
  state: 'running' | 'stopped' | 'crashed' | 'pending',
  pid: number | null,
  exit_code?: number,
): Promise<void> {
  // node / dev-process-md は docker scanner が instance 行を作らないため、
  // 無ければここで 1 行確保してから state を書く (UPDATE が no-op にならないように)。
  db().run(sql`
    INSERT INTO service_instances (id, service_id, state, created_at, updated_at)
    SELECT lower(hex(randomblob(16))), s.id, 'pending', unixepoch() * 1000, unixepoch() * 1000
    FROM services s
    WHERE s.code = ${code}
      AND NOT EXISTS (SELECT 1 FROM service_instances si WHERE si.service_id = s.id)
  `);
  // PG の UPDATE ... FROM 構文は SQLite に無ぁE�Eで、Eservice_id めEsubquery で解決する、E
  db().run(sql`
    UPDATE service_instances
    SET state = ${state},
        pid = ${pid},
        last_seen_at = unixepoch() * 1000,
        started_at = CASE WHEN ${state} = 'running' THEN unixepoch() * 1000 ELSE started_at END,
        exit_code = ${exit_code ?? null},
        updated_at = unixepoch() * 1000
    WHERE service_id IN (SELECT id FROM services WHERE code = ${code})
  `);
}

async function raiseRestartLimitError(
  svc: Service,
  exitCode: number,
  signal: NodeJS.Signals | null,
  max: number,
): Promise<void> {
  const newId = randomUUID();
  db().run(sql`
    INSERT INTO error_tasks (id, service_instance_id, severity, summary, log_excerpt)
    SELECT ${newId}, si.id, 'fatal',
           ${'restart limit reached (max=' + max + ', exit_code=' + exitCode + ', signal=' + (signal ?? 'none') + ')'},
           NULL
    FROM service_instances si
    JOIN services s ON s.id = si.service_id
    WHERE s.code = ${svc.code}
    LIMIT 1
  `);
}





