/**
 * ProcessManager — runtime=node / dev-process-md のサービスを Excubitor server から
 * spawn して監視する。
 *
 * v0.1 (this file) でやること:
 *   - spawn (env injection 対応)
 *   - stdout / stderr の line バッファリング + line-by-line ハンドラ
 *   - exit 検知 + restart_policy 適用
 *   - 状態を service_instances テーブルに反映
 *
 * spawn 出力のログ蓄積 (process_logs テーブル) と error detector は別 module で。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { sql } from 'drizzle-orm';
import pino from 'pino';
import { db } from '../db/client.js';
import type { Service } from '../catalog/loader.js';
import { resolveDevProcessCommand } from './dev-process-md.js';

const logger = pino({ name: 'excubitor.process' });

export interface SpawnedProcess {
  code: string;
  child: ChildProcess;
  startedAt: Date;
  restartCount: number;
}

type LineHandler = (svc: Service, channel: 'stdout' | 'stderr', line: string) => void;

const processes = new Map<string, SpawnedProcess>();
const lineHandlers = new Set<LineHandler>();

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
  /** env を上書き (Infisical secret inject 等)。 process.env にマージされる。 */
  env?: Record<string, string>;
  /** restart_policy / max_restart は service catalog 値を使うが、 外部から渡しても良い。 */
  restartPolicy?: 'no' | 'on-failure' | 'always';
  maxRestart?: number;
  /** 以前の restartCount を引き継いで spawn する (restart のため)。 */
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
    [cmd, ...args] = splitCommand(svc.command);
  } else {
    // dev-process-md
    const parsed = await resolveDevProcessCommand(svc.cwd);
    [cmd, ...args] = splitCommand(parsed);
  }

  const child = spawn(cmd, args, {
    cwd: svc.cwd,
    shell: true, // Windows での npm 等の解決を簡単にするため shell 経由
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const restartCount = opts.initialRestartCount ?? 0;
  const spawned: SpawnedProcess = { code: svc.code, child, startedAt: new Date(), restartCount };
  processes.set(svc.code, spawned);
  logger.info({ code: svc.code, pid: child.pid, restartCount }, 'spawned');

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
  if (!p) return false;
  // Windows では SIGTERM が即 kill にならないため、 short timeout で SIGKILL fallback
  try { p.child.kill(signal); } catch { /* noop */ }
  setTimeout(() => {
    if (processes.has(code)) {
      try { p.child.kill('SIGKILL'); } catch { /* noop */ }
    }
  }, 5000);
  return true;
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
      'restart limit reached — opening error_task',
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
  // ナイーブ split; quote 内のスペースは未対応。 catalog で sensible な command を書く前提。
  return input.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((s) => s.replace(/^"|"$/g, '')) ?? [input];
}

async function updateState(
  code: string,
  state: 'running' | 'stopped' | 'crashed' | 'pending',
  pid: number | null,
  exit_code?: number,
): Promise<void> {
  await db.execute(sql`
    UPDATE service_instances si
    SET state = ${state},
        pid = ${pid},
        last_seen_at = now(),
        started_at = CASE WHEN ${state} = 'running' THEN now() ELSE si.started_at END,
        exit_code = ${exit_code ?? null},
        updated_at = now()
    FROM services s
    WHERE si.service_id = s.id AND s.code = ${code}
  `);
}

async function raiseRestartLimitError(
  svc: Service,
  exitCode: number,
  signal: NodeJS.Signals | null,
  max: number,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO error_tasks (service_instance_id, severity, summary, log_excerpt)
    SELECT si.id, 'fatal',
           ${'restart limit reached (max=' + max + ', exit_code=' + exitCode + ', signal=' + (signal ?? 'none') + ')'},
           NULL
    FROM service_instances si
    JOIN services s ON s.id = si.service_id
    WHERE s.code = ${svc.code}
    LIMIT 1
  `);
}
