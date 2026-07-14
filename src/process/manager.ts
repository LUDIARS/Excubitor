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
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createNamedLogger } from '../shared/logger.js';
import { db } from '../db/client.js';
import type { Service } from '../catalog/loader.js';
import { resolveDevProcessCommand } from './dev-process-md.js';
import { execCapture } from '../shared/exec.js';
import { startProcessLog, stopProcessLog } from '../log/process-file.js';
import { runServiceBuild } from './build.js';
import { assertStartupEnv } from './startup-env.js';
import { maybeDispatchCrashFixToConcordia } from '../auto_fix/concordia-dispatch.js';
import { assertHotReloadAllowed, type HotReloadSource } from './hot-reload.js';
import { prepareSpawnEnv } from './cernere-launch-credential.js';
import { verifyProcessIdentity, type VerifiedProcessIdentity } from './identity.js';

const logger = createNamedLogger('excubitor.process');

export interface SpawnedProcess {
  code: string;
  child: ChildProcess;
  startedAt: Date;
  restartCount: number;
}

interface ManagedProcess extends SpawnedProcess {
  intentionalStop: boolean;
  termination: Promise<void>;
  resolveTermination: () => void;
}

type LineHandler = (svc: Service, channel: 'stdout' | 'stderr', line: string) => void;

const processes = new Map<string, ManagedProcess>();
const spawnReservations = new Map<string, number>();
const spawnSettlements = new Map<string, {
  generation: number;
  settled: Promise<void>;
  resolve: () => void;
  failure?: Error;
}>();
const restartTimers = new Map<string, NodeJS.Timeout>();
const desiredStates = new Map<string, { state: 'running' | 'stopped'; generation: number }>();
let restartSchedulingEnabled = true;
const TERMINATION_GRACE_MS = 5_000;
const TERMINATION_POLL_MS = 50;

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
export function adoptProcess(code: string, identity: VerifiedProcessIdentity): void {
  if (processes.has(code)) return;
  adopted.set(code, { code, pid: identity.pid, startedAt: identity.startedAt });
  markServiceRunning(code);
}

/** code が (自前 spawn or 再採用で) 管理下にあるか。 */
export function isManaged(code: string): boolean {
  return processes.has(code) || adopted.has(code);
}

/**
 * Revalidate the operating-system identity behind a managed entry.
 * Adopted PIDs can be reused after the original process exits, so callers that
 * make lifecycle decisions must use this check instead of trusting map state.
 */
export async function validateManagedProcess(code: string): Promise<boolean> {
  const spawned = processes.get(code);
  if (spawned) {
    if (spawned.child.exitCode === null && spawned.child.signalCode === null) return true;
    if (processes.get(code) !== spawned) return true;
    processes.delete(code);
    await updateState(code, 'crashed', null, spawned.child.exitCode ?? undefined);
    return false;
  }

  const candidate = adopted.get(code);
  if (!candidate) return false;
  const verified = await verifyProcessIdentity(candidate.pid, candidate.startedAt);
  if (verified) return adopted.get(code) === candidate || processes.has(code);

  // Identity verification is asynchronous. Never remove an entry that was
  // replaced by reconciliation or a concurrent start while verification ran.
  if (adopted.get(code) !== candidate) return isManaged(code);
  adopted.delete(code);
  await updateState(code, 'crashed', null);
  return false;
}

export function listAdoptedProcessCodes(): string[] {
  return Array.from(adopted.keys());
}

export function isAdoptedProcess(code: string): boolean {
  return adopted.has(code);
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

export function getManagedPid(code: string): number | undefined {
  return processes.get(code)?.child.pid ?? adopted.get(code)?.pid;
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
  /** Test/explicit override. Normal service starts use catalog allow_hot_reload. */
  allowHotReload?: boolean;
  /** Internal generation used to cancel a start that became stale while awaiting I/O. */
  expectedGeneration?: number;
}

export function markServiceRunning(code: string): number {
  return updateDesiredState(code, 'running');
}

export function markServiceStopped(code: string): boolean {
  const hadPendingWork = restartTimers.has(code) || spawnReservations.has(code);
  updateDesiredState(code, 'stopped');
  return hadPendingWork;
}

export function cancelServiceRestart(code: string): number {
  const current = desiredStates.get(code);
  return updateDesiredState(code, current?.state ?? 'running');
}

export function isServiceDesiredRunning(code: string): boolean {
  return desiredStates.get(code)?.state === 'running';
}

export async function waitForPendingSpawn(code: string): Promise<void> {
  const pending = spawnSettlements.get(code);
  if (pending) await pending.settled;
}

export function suspendProcessRestarts(): void {
  restartSchedulingEnabled = false;
  for (const timer of restartTimers.values()) clearTimeout(timer);
  restartTimers.clear();
  for (const [code, desired] of desiredStates) {
    desiredStates.set(code, { state: desired.state, generation: desired.generation + 1 });
  }
}

export function resumeProcessRestarts(): void {
  restartSchedulingEnabled = true;
}

function updateDesiredState(code: string, state: 'running' | 'stopped'): number {
  const timer = restartTimers.get(code);
  if (timer) clearTimeout(timer);
  restartTimers.delete(code);
  const generation = (desiredStates.get(code)?.generation ?? 0) + 1;
  desiredStates.set(code, { state, generation });
  return generation;
}

function isCurrentRunningGeneration(code: string, generation: number): boolean {
  const desired = desiredStates.get(code);
  return restartSchedulingEnabled && desired?.state === 'running' && desired.generation === generation;
}

function reserveSpawn(code: string, expectedGeneration?: number): number {
  if (!restartSchedulingEnabled) throw new Error(`service ${code} start canceled: supervisor is shutting down`);
  if (processes.has(code) || adopted.has(code) || spawnReservations.has(code)) {
    throw new Error(`service ${code} is already managed or being started`);
  }
  const generation = expectedGeneration ?? markServiceRunning(code);
  if (!isCurrentRunningGeneration(code, generation)) {
    throw new Error(`service ${code} start canceled by a newer lifecycle request`);
  }
  spawnReservations.set(code, generation);
  let resolveSettlement = (): void => undefined;
  const settled = new Promise<void>((resolve) => {
    resolveSettlement = resolve;
  });
  spawnSettlements.set(code, { generation, settled, resolve: resolveSettlement });
  return generation;
}

export async function spawnService(svc: Service, opts: SpawnOptions = {}): Promise<SpawnedProcess> {
  const generation = reserveSpawn(svc.code, opts.expectedGeneration);
  try {
    return await spawnReservedService(svc, { ...opts, expectedGeneration: generation });
  } finally {
    if (spawnReservations.get(svc.code) === generation) spawnReservations.delete(svc.code);
    const settlement = spawnSettlements.get(svc.code);
    if (settlement?.generation === generation) {
      spawnSettlements.delete(svc.code);
      settlement.resolve();
    }
  }
}

async function spawnReservedService(svc: Service, opts: SpawnOptions): Promise<SpawnedProcess> {
  if (processes.has(svc.code)) {
    throw new Error(`service ${svc.code} is already spawned`);
  }
  if (svc.runtime !== 'node' && svc.runtime !== 'dev-process-md' && svc.runtime !== 'app') {
    throw new Error(`spawnService: unsupported runtime ${svc.runtime}`);
  }

  let cmd: string;
  let args: string[];
  let hotReloadSource: HotReloadSource;
  // 起動方式の解決。 runtime=node/dev-process-md で start_script があれば最優先で使う
  // (= 既存 start-<service>.bat の pull/build/dev 一式をそのまま起動)。
  if (svc.runtime !== 'app' && svc.start_script) {
    cmd = svc.start_script;
    args = [];
    hotReloadSource = { kind: 'start_script', path: svc.start_script };
  } else if (svc.runtime === 'app') {
    // ローカルアプリ: exec (実行ファイル) を直接起動。 cwd は任意 (exec の dir 既定)。
    if (!svc.exec) throw new Error(`service ${svc.code} has no exec`);
    cmd = svc.exec;
    args = svc.exec_args ?? [];
    hotReloadSource = { kind: 'command', command: [cmd, ...args].join(' ') };
  } else if (svc.runtime === 'node') {
    if (!svc.cwd) throw new Error(`service ${svc.code} has no cwd`);
    if (!svc.command) throw new Error(`service ${svc.code} has no command`);
    const parts = splitCommand(svc.command);
    const first = parts.shift();
    if (!first) throw new Error(`service ${svc.code} command is empty`);
    cmd = first;
    args = parts;
    hotReloadSource = { kind: 'command', command: svc.command };
  } else {
    // dev-process-md
    if (!svc.cwd) throw new Error(`service ${svc.code} has no cwd`);
    const parsed = await resolveDevProcessCommand(svc.cwd);
    const parts = splitCommand(parsed);
    const first = parts.shift();
    if (!first) throw new Error(`service ${svc.code} command is empty`);
    cmd = first;
    args = parts;
    hotReloadSource = { kind: 'dev-process-md', command: parsed };
  }

  // #84: detached 子の stdout/stderr は親所有の「ファイル fd」に向ける (pipe ではなく)。
  // 親 (Excubitor) が落ちても write 先が生存するため EPIPE で子が即死しない。
  // ライブログ/エラー検知は process-file がこのファイルを tail して log bus に publish する。
  await assertHotReloadAllowed(svc, hotReloadSource, { allowHotReload: opts.allowHotReload });

  // build完了後、実spawnの直前に起動単位credentialを発行する。
  // issuer secretはprepareSpawnEnv内で削除され、子にはtarget credentialだけが渡る。
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
  const childEnv = await prepareSpawnEnv(svc, { ...inheritedEnv, ...(opts.env ?? {}) });

  // credential preparation performs asynchronous I/O. A stop or supervisor
  // shutdown may invalidate this reservation while it is in flight; recheck
  // immediately before the synchronous log-open/spawn sequence.
  const generation = opts.expectedGeneration;
  if (generation === undefined || !isCurrentRunningGeneration(svc.code, generation)) {
    throw new Error(`service ${svc.code} start canceled by a newer lifecycle request`);
  }
  await updateState(svc.code, 'pending', null);
  if (!isCurrentRunningGeneration(svc.code, generation)) {
    throw new Error(`service ${svc.code} start canceled by a newer lifecycle request`);
  }

  const { stdoutFd, stderrFd } = startProcessLog(svc.code);
  // cwd 既定: catalog cwd → (app) exec の dir → (start_script) スクリプトの dir。
  const resolvedCwd =
    svc.cwd ??
    (svc.runtime === 'app' && svc.exec
      ? dirname(svc.exec)
      : svc.start_script
        ? dirname(svc.start_script)
        : undefined);
  // Managed services are deliberately detached from the supervisor's process
  // group/job. This is the failure-domain boundary that lets them survive an
  // OS-manager restart of the local-control supervisor. windowsHide keeps the
  // Scheduled Task path non-interactive; explicit stop still uses taskkill /T.
  const detached = true;
  let child: ChildProcess;
  let spawnedAt: Date;
  try {
    child = spawn(cmd, args, {
    cwd: resolvedCwd,
    // node/dev-process-md/start_script は npm / .bat 解決のため shell 経由。
    // app は exe を直接起動する (shell:true だとパスの空白/backslash で壊れる)。
    shell: svc.runtime !== 'app',
    env: childEnv,
    stdio: ['ignore', stdoutFd, stderrFd],
    detached,
      windowsHide: true,
    });
    spawnedAt = new Date();
  } catch (err) {
    await recordSpawnFailure(svc.code, err);
    throw err;
  }
  // 親 (Excubitor) の event loop を子に縛られないよう unref。
  child.unref();

  try {
    // Attach spawn/error listeners first, then durably publish the pid before
    // waiting for spawn completion. Reconciliation can adopt this detached
    // process if the supervisor dies during the spawn event window.
    await Promise.all([
      waitForSpawn(child),
      updateState(svc.code, 'pending', child.pid ?? null, undefined, spawnedAt),
    ]);
  } catch (err) {
    let cleanupFailure: Error | null = null;
    try {
      await terminateUnregisteredChild(svc.code, child);
    } catch (cleanupError) {
      retainRejectedSpawn(svc.code, child, spawnedAt, cleanupError);
      cleanupFailure = cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError));
      logger.error({ code: svc.code, err: (cleanupError as Error).message }, 'failed to terminate rejected spawn');
    }
    if (cleanupFailure && child.pid) {
      stopProcessLog(svc.code);
      await updateState(svc.code, 'pending', child.pid, undefined, spawnedAt).catch((stateError: unknown) => {
        logger.error({ code: svc.code, err: (stateError as Error).message }, 'failed to retain rejected spawn identity');
      });
      throw new AggregateError([err, cleanupFailure], `spawn failed and service ${svc.code} could not be terminated`);
    }
    await recordSpawnFailure(svc.code, err);
    throw err;
  }

  // spawn completion is asynchronous as well. If stop/shutdown won the race,
  // terminate the unregistered child before resolving the reservation so the
  // stop caller cannot return while a stale process is still being introduced.
  if (!isCurrentRunningGeneration(svc.code, generation)) {
    try {
      await terminateUnregisteredChild(svc.code, child);
    } catch (cleanupError) {
      retainRejectedSpawn(svc.code, child, spawnedAt, cleanupError);
      throw cleanupError;
    } finally {
      stopProcessLog(svc.code);
    }
    throw new Error(`service ${svc.code} start canceled by a newer lifecycle request`);
  }

  // adopted 側に同 code が残っていれば、 自前 spawn が真実なので除去。
  adopted.delete(svc.code);
  const restartCount = opts.initialRestartCount ?? 0;
  let resolveTermination = (): void => undefined;
  const termination = new Promise<void>((resolve) => {
    resolveTermination = resolve;
  });
  const spawned: ManagedProcess = {
    code: svc.code,
    child,
    startedAt: spawnedAt,
    restartCount,
    intentionalStop: false,
    termination,
    resolveTermination,
  };
  processes.set(svc.code, spawned);
  logger.info({ code: svc.code, pid: child.pid, restartCount, detached }, 'spawned (windowless)');

  const runningState = updateState(svc.code, 'running', child.pid ?? null, undefined, spawnedAt);

  child.once('exit', (code, signal) => {
    if (processes.get(svc.code)?.child === child) processes.delete(svc.code);
    stopProcessLog(svc.code);
    logger.info(
      { code: svc.code, exit_code: code, signal, restartCount },
      'process exited',
    );
    void (async () => {
      try {
        await runningState.catch(() => undefined);
        await onExit(svc, code, signal, restartCount, opts, spawned.intentionalStop);
      } finally {
        spawned.resolveTermination();
      }
    })();
  });

  child.on('error', (err) => {
    logger.error({ code: svc.code, err: err.message }, 'child error');
  });

  await runningState.catch((error: unknown) => {
    // The process side effect is real and its pending pid identity was already
    // persisted. Keep the successful lifecycle result truthful; reconciliation
    // can adopt the pending row if this supervisor exits before a later scan.
    logger.error({ code: svc.code, err: (error as Error).message }, 'failed to promote spawned service state to running');
  });

  return spawned;
}

export async function killService(code: string, signal: NodeJS.Signals = 'SIGTERM'): Promise<boolean> {
  const pendingSpawn = spawnSettlements.get(code);
  const canceledRestart = markServiceStopped(code);
  if (pendingSpawn) await pendingSpawn.settled;
  const p = processes.get(code);
  if (p) {
    p.intentionalStop = true;
    try {
      await terminateManagedProcess(p, signal);
      return true;
    } catch (err) {
      if (processes.get(code) === p) p.intentionalStop = false;
      throw err;
    }
  }
  // 再採用したサービス: ChildProcess を持たないので pid で kill。
  const a = adopted.get(code);
  if (a) {
    const verified = await verifyProcessIdentity(a.pid, a.startedAt);
    if (!verified) {
      adopted.delete(code);
      const alive = isPidAlive(a.pid);
      await updateState(code, alive ? 'crashed' : 'stopped', null);
      if (!alive) return true;
      throw new Error(`refusing to stop stale or unverified adopted process ${code} pid=${a.pid}`);
    }
    await treeKill(a.pid);
    adopted.delete(code);
    await updateState(code, 'stopped', null, 0);
    return true;
  }
  if (pendingSpawn?.failure) throw pendingSpawn.failure;
  return canceledRestart;
}

function retainRejectedSpawn(code: string, child: ChildProcess, startedAt: Date, error: unknown): void {
  const failure = error instanceof Error ? error : new Error(String(error));
  const settlement = spawnSettlements.get(code);
  if (settlement) settlement.failure = failure;
  if (child.pid) adopted.set(code, { code, pid: child.pid, startedAt });
}

async function terminateUnregisteredChild(code: string, child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    await treeKill(pid);
    return;
  }

  const groupSignaled = signalDetachedTree(pid, 'SIGTERM');
  const childSignaled = child.kill('SIGTERM');
  if (!groupSignaled && !childSignaled && isDetachedTreeAlive(pid)) {
    throw new Error(`failed to cancel stale service ${code} pid=${pid}`);
  }
  if (await waitForChildTreeExit(child, pid, TERMINATION_GRACE_MS)) return;
  const groupForced = signalDetachedTree(pid, 'SIGKILL');
  const childForced = child.kill('SIGKILL');
  if (!groupForced && !childForced && isDetachedTreeAlive(pid)) {
    throw new Error(`failed to force-cancel stale service ${code} pid=${pid}`);
  }
  if (!(await waitForChildTreeExit(child, pid, TERMINATION_GRACE_MS))) {
    throw new Error(`stale service ${code} pid=${pid} did not terminate`);
  }
}

async function waitForChildTreeExit(child: ChildProcess, pid: number, timeoutMs: number): Promise<boolean> {
  const [childExited, treeExited] = await Promise.all([
    waitForChildExit(child, timeoutMs),
    waitForDetachedTreeExit(pid, timeoutMs),
  ]);
  return childExited && treeExited;
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

/** pid のプロセスツリーを終了する (Windows=taskkill /T /F、 他=SIGTERM→SIGKILL)。 */
async function treeKill(pid: number): Promise<void> {
  if (!isDetachedTreeAlive(pid)) return;

  if (process.platform === 'win32') {
    const result = await execCapture('taskkill', ['/PID', String(pid), '/T', '/F'], process.cwd(), 10000);
    if (!result.ok && isPidAlive(pid)) {
      throw new Error(`taskkill failed for pid=${pid}: ${result.stderr || `exit_code=${result.code ?? -1}`}`);
    }
  } else {
    signalDetachedTree(pid, 'SIGTERM');
    if (await waitForDetachedTreeExit(pid, TERMINATION_GRACE_MS)) return;
    signalDetachedTree(pid, 'SIGKILL');
  }

  if (!(await waitForDetachedTreeExit(pid, TERMINATION_GRACE_MS))) {
    throw new Error(`process pid=${pid} did not terminate`);
  }
}

async function onExit(
  svc: Service,
  code: number | null,
  signal: NodeJS.Signals | null,
  prevRestartCount: number,
  opts: SpawnOptions,
  intentionalStop: boolean,
): Promise<void> {
  const policy = opts.restartPolicy ?? svc.restart_policy;
  const max = opts.maxRestart ?? svc.max_restart;
  const cleanExit = code === 0 && !signal;

  await updateState(svc.code, intentionalStop || cleanExit ? 'stopped' : 'crashed', null, code ?? undefined);

  if (intentionalStop) return;

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
  const desired = desiredStates.get(svc.code);
  if (!restartSchedulingEnabled || desired?.state !== 'running') return;
  const generation = desired.generation;
  const delay = Math.min(30_000, 1000 * 2 ** prevRestartCount);
  const existingTimer = restartTimers.get(svc.code);
  if (existingTimer) clearTimeout(existingTimer);
  const timer = setTimeout(() => {
    if (restartTimers.get(svc.code) === timer) restartTimers.delete(svc.code);
    if (!isCurrentRunningGeneration(svc.code, generation)) return;
    void autoRestartService(svc, opts, prevRestartCount, generation).catch((err: unknown) =>
      logger.error({ code: svc.code, err: (err as Error).message }, 'auto-restart failed'),
    );
  }, delay);
  timer.unref?.();
  restartTimers.set(svc.code, timer);
}

async function autoRestartService(
  svc: Service,
  opts: SpawnOptions,
  prevRestartCount: number,
  generation: number,
): Promise<void> {
  if (!isCurrentRunningGeneration(svc.code, generation)) return;
  assertStartupEnv(svc, opts.env ?? {});
  const build = await runServiceBuild(svc, 'auto-restart');
  if (!build.ok) {
    logger.error(
      { code: svc.code, command: build.command, stderr: build.stderr.slice(-500) },
      'auto-restart build failed',
    );
    await raiseRestartBuildError(svc, build.command, build.stderr || build.stdout);
    return;
  }
  if (!isCurrentRunningGeneration(svc.code, generation)) return;
  await spawnService(svc, {
      ...opts,
      initialRestartCount: prevRestartCount + 1,
      expectedGeneration: generation,
    });
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = (): void => {
      child.off('error', onError);
      resolve();
    };
    const onError = (err: Error): void => {
      child.off('spawn', onSpawn);
      reject(err);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

async function recordSpawnFailure(code: string, err: unknown): Promise<void> {
  processes.delete(code);
  try {
    stopProcessLog(code);
  } catch (logErr) {
    logger.error({ code, err: (logErr as Error).message }, 'failed to close process log after spawn failure');
  }
  const message = err instanceof Error ? err.message : String(err);
  logger.error({ code, err: message }, 'spawn failed');
  try {
    await updateState(code, 'crashed', null);
  } catch (stateErr) {
    logger.error({ code, err: (stateErr as Error).message }, 'failed to record spawn failure state');
  }
}

async function terminateManagedProcess(
  processEntry: ManagedProcess,
  signal: NodeJS.Signals,
): Promise<void> {
  const pid = processEntry.child.pid;
  if (!pid) throw new Error(`service ${processEntry.code} has no process id`);

  if (process.platform === 'win32') {
    await treeKill(pid);
  } else {
    const groupSignalSent = signalDetachedTree(pid, signal);
    const childSignalSent = processEntry.child.kill(signal);
    if (!groupSignalSent && !childSignalSent && isDetachedTreeAlive(pid)) {
      throw new Error(`failed to signal service ${processEntry.code} pid=${pid}`);
    }
  }

  if (await waitForManagedTreeTermination(processEntry, pid, TERMINATION_GRACE_MS)) return;

  const groupForceSent = process.platform === 'win32' ? false : signalDetachedTree(pid, 'SIGKILL');
  const childForceSent = processEntry.child.kill('SIGKILL');
  if (!groupForceSent && !childForceSent && isDetachedTreeAlive(pid)) {
    throw new Error(`failed to force-stop service ${processEntry.code} pid=${pid}`);
  }
  if (!(await waitForManagedTreeTermination(processEntry, pid, TERMINATION_GRACE_MS))) {
    throw new Error(`service ${processEntry.code} pid=${pid} did not terminate`);
  }
}

async function waitForManagedTreeTermination(
  processEntry: ManagedProcess,
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const [childExited, treeExited] = await Promise.all([
    withBooleanTimeout(processEntry.termination, timeoutMs),
    waitForDetachedTreeExit(pid, timeoutMs),
  ]);
  return childExited && treeExited;
}

async function waitForDetachedTreeExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isDetachedTreeAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, TERMINATION_POLL_MS));
  }
  return true;
}

function signalDetachedTree(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH') throw error;
  }
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    return false;
  }
}

function isDetachedTreeAlive(pid: number): boolean {
  if (process.platform === 'win32') return isPidAlive(pid);
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
  }
  return isPidAlive(pid);
}

function withBooleanTimeout(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    void promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
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
  startedAt?: Date,
): Promise<void> {
  // node / dev-process-md は docker scanner が instance 行を作らないため、
  // 無ければここで 1 行確保してから state を書く (UPDATE が no-op にならないように)。
  const explicitStartedAt = startedAt?.getTime() ?? null;
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
        started_at = CASE
          WHEN ${explicitStartedAt} IS NOT NULL THEN ${explicitStartedAt}
          WHEN ${state} = 'running' OR (${state} = 'pending' AND ${pid} IS NOT NULL)
            THEN unixepoch() * 1000
          ELSE started_at
        END,
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
  const summary = 'restart limit reached (max=' + max + ', exit_code=' + exitCode + ', signal=' + (signal ?? 'none') + ')';
  // first_seen_at / last_seen_at は NOT NULL かつ SQL default 無し → 明示指定が必要。
  db().run(sql`
    INSERT INTO error_tasks (id, service_instance_id, severity, summary, log_excerpt, first_seen_at, last_seen_at)
    SELECT ${newId}, si.id, 'fatal',
           ${summary},
           NULL, unixepoch() * 1000, unixepoch() * 1000
    FROM service_instances si
    JOIN services s ON s.id = si.service_id
    WHERE s.code = ${svc.code}
    LIMIT 1
  `);
  await maybeDispatchCrashFixToConcordia({
    errorTaskId: newId,
    service: svc,
    severity: 'fatal',
    summary,
    logExcerpt: `exit_code=${exitCode} signal=${signal ?? 'none'} max=${max}`,
    source: 'process',
  });
}

async function raiseRestartBuildError(
  svc: Service,
  command: string,
  output: string,
): Promise<void> {
  const newId = randomUUID();
  const summary = 'auto-restart build failed: ' + command;
  const excerpt = output.slice(-2000);
  db().run(sql`
    INSERT INTO error_tasks (id, service_instance_id, severity, summary, log_excerpt, first_seen_at, last_seen_at)
    SELECT ${newId}, si.id, 'fatal',
           ${summary},
           ${excerpt}, unixepoch() * 1000, unixepoch() * 1000
    FROM service_instances si
    JOIN services s ON s.id = si.service_id
    WHERE s.code = ${svc.code}
    LIMIT 1
  `);
  await maybeDispatchCrashFixToConcordia({
    errorTaskId: newId,
    service: svc,
    severity: 'fatal',
    summary,
    logExcerpt: excerpt,
    source: 'process',
  });
}
