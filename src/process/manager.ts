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
import { resolveExecutable } from './executable-resolver.js';
import { execCapture } from '../shared/exec.js';
import { ensureProcessLogPaths, startProcessLog, stopProcessLog } from '../log/process-file.js';
import { runServiceBuild } from './build.js';
import { assertStartupEnv } from './startup-env.js';
import { maybeDispatchCrashFixToConcordia } from '../auto_fix/concordia-dispatch.js';
import { assertHotReloadAllowed, type HotReloadSource } from './hot-reload.js';
import { prepareSpawnEnv } from './cernere-launch-credential.js';
import { injectServiceRuntimeVersion, SERVICE_VERSION_ENV } from './service-version.js';
import { verifyProcessIdentity, waitForProcessIdentity, type VerifiedProcessIdentity } from './identity.js';
import { spawnOutsideJob, type BreakawaySpawnOptions } from './breakaway-spawn.js';
import { clearDeclaredPort } from './port-guard.js';

const logger = createNamedLogger('excubitor.process');

export interface SpawnedProcess {
  code: string;
  /** job-breakaway 起動 (win32 既定) は ChildProcess を持たない (pid 管理)。 */
  child: ChildProcess | null;
  pid: number | null;
  startedAt: Date;
  restartCount: number;
}

interface ManagedProcess extends SpawnedProcess {
  child: ChildProcess;
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

/** A PID must never be owned by more than one catalog service. */
export function isPidManaged(pid: number): boolean {
  for (const processEntry of processes.values()) {
    if (processEntry.child.pid === pid) return true;
  }
  for (const processEntry of adopted.values()) {
    if (processEntry.pid === pid) return true;
  }
  return false;
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
    await updateInstanceStatus(code, 'crashed', null, spawned.child.exitCode ?? undefined);
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
  await updateInstanceStatus(code, 'crashed', null);
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
  /** テスト用: job-breakaway spawn の PowerShell 実行差し替え。 */
  breakaway?: BreakawaySpawnOptions;
  /** テスト用: 宣言ポートの占有解消の差し替え。 */
  clearPort?: typeof clearDeclaredPort;
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

/**
 * spawn 時に `detached` を立てるか (design.md §15.1)。
 *
 * POSIX: managed services are deliberately detached (own process group) so they
 * survive an OS-manager restart of the local-control supervisor.
 * Windows: detached を外す。 DETACHED_PROCESS と併用すると windowsHide の
 * CREATE_NO_WINDOW が CreateProcess 仕様で無視され、 shell 経由の cmd.exe が自前の
 * コンソール窓を開く。 Windows は親終了で子を連鎖終了しないため再起動耐性に detached は
 * 不要 (boot 時の reconcile/adoptProcess は不変)。 停止は従来どおり taskkill /T /F。
 */
export function shouldDetachSpawn(platform: NodeJS.Platform): boolean {
  return platform !== 'win32';
}

/** @implements SPEC-SERVICE-RUNTIME-VERSION */
async function spawnReservedService(svc: Service, opts: SpawnOptions): Promise<SpawnedProcess> {
  if (processes.has(svc.code)) {
    throw new Error(`service ${svc.code} is already spawned`);
  }
  if (svc.runtime !== 'node' && svc.runtime !== 'dev-process-md' && svc.runtime !== 'app') {
    throw new Error(`spawnService: unsupported runtime ${svc.runtime}`);
  }

  // 宣言ポートを取りこぼした旧インスタンスが握っていると、新プロセスは EADDRINUSE で
  // 即死し「再起動したのに古いコードが動き続ける」状態になる (port-guard.ts の背景参照)。
  // spawn 前に必ず確認し、管理外の占有は止めてから進む。
  await (opts.clearPort ?? clearDeclaredPort)(
    svc.code,
    svc.port,
    getManagedPid(svc.code),
    { kill: treeKill },
  );

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
  const inheritedEnv = inheritableSupervisorEnv(process.env);
  const preparedEnv = await prepareSpawnEnv(svc, { ...inheritedEnv, ...(opts.env ?? {}) });
  const { env: childEnv, version } = await injectServiceRuntimeVersion(svc, preparedEnv);
  logger.info(
    { code: svc.code, version: version.value, versionSource: version.source },
    'service runtime version injected',
  );

  // credential preparation performs asynchronous I/O. A stop or supervisor
  // shutdown may invalidate this reservation while it is in flight; recheck
  // immediately before the synchronous log-open/spawn sequence.
  const generation = opts.expectedGeneration;
  if (generation === undefined || !isCurrentRunningGeneration(svc.code, generation)) {
    throw new Error(`service ${svc.code} start canceled by a newer lifecycle request`);
  }
  await updateInstanceStatus(svc.code, 'pending', null);
  if (!isCurrentRunningGeneration(svc.code, generation)) {
    throw new Error(`service ${svc.code} start canceled by a newer lifecycle request`);
  }

  // cwd 既定: catalog cwd → (app) exec の dir → (start_script) スクリプトの dir。
  const resolvedCwd =
    svc.cwd ??
    (svc.runtime === 'app' && svc.exec
      ? dirname(svc.exec)
      : svc.start_script
        ? dirname(svc.start_script)
        : undefined);

  // win32 の supervisor は Scheduled Task の Job Object 内で動き、`detached: true`
  // では子が Job を継承して脱出できない (detached は CREATE_NEW_PROCESS_GROUP /
  // DETACHED_PROCESS であって CREATE_BREAKAWAY_FROM_JOB ではない)。Task の
  // tree-kill で全サービスが道連れになった実障害 (2026-08-02) の根治として、
  // win32 既定は WMI 経由の job-breakaway spawn を使い、生成 pid を adopted と
  // 同じ pid 管理 (reaper 再起動 / taskkill /T stop) に載せる (design.md §17)。
  if (resolveSpawnStrategy() === 'job-breakaway') {
    // launcher が Node の spawn で起動するため、コマンドは child 戦略と同じ
    // (cmd, args, shell) の形のまま渡す。 文字列へ畳まないので引用の食い違いも起きない。
    // app は元から exe 直起動。それ以外は先頭語を実行ファイルへ解決し、cmd.exe が
    // 本当に要る (.cmd / .bat) 場合だけ shell を挟む (§17.4.2)。cmd.exe を挟むと
    // 返り pid が cmd.exe になって pid 契約が破れ、detached も付けられなくなる。
    const resolved = svc.runtime === 'app'
      ? { command: cmd, shell: false }
      : resolveExecutable(cmd, { cwd: resolvedCwd, env: childEnv });
    return spawnBreakawayService(svc, opts, generation, childEnv, resolvedCwd, {
      command: resolved.command,
      args,
      shell: resolved.shell,
    });
  }

  const { stdoutFd, stderrFd } = startProcessLog(svc.code);
  // child 戦略: POSIX はプロセスグループ生存のため detached を維持し、win32 で
  // child 戦略を明示した場合は design.md §15.1 のとおり detached を外して
  // CREATE_NO_WINDOW (windowsHide) を有効にする。
  const detached = shouldDetachSpawn(process.platform);
  let child: ChildProcess;
  let spawnedAt: Date;
  try {
    // breakaway 戦略と同じ解決を使う (§17.4.2)。cmd.exe が要る入口だけ shell を挟む。
    const resolvedChild = svc.runtime === 'app'
      ? { command: cmd, shell: false }
      : resolveExecutable(cmd, { cwd: resolvedCwd, env: childEnv });
    child = spawn(resolvedChild.command, args, {
      cwd: resolvedCwd,
      shell: resolvedChild.shell,
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
      updateInstanceStatus(svc.code, 'pending', child.pid ?? null, undefined, spawnedAt),
    ]);
  } catch (err) {
    let cleanupFailure: Error | null = null;
    try {
      await terminateUnregisteredChild(svc.code, child);
    } catch (cleanupError) {
      retainRejectedSpawn(svc.code, child.pid, spawnedAt, cleanupError);
      cleanupFailure = cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError));
      logger.error({ code: svc.code, err: (cleanupError as Error).message }, 'failed to terminate rejected spawn');
    }
    if (cleanupFailure && child.pid) {
      stopProcessLog(svc.code);
      await updateInstanceStatus(svc.code, 'pending', child.pid, undefined, spawnedAt).catch((stateError: unknown) => {
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
      retainRejectedSpawn(svc.code, child.pid, spawnedAt, cleanupError);
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
    pid: child.pid ?? null,
    startedAt: spawnedAt,
    restartCount,
    intentionalStop: false,
    termination,
    resolveTermination,
  };
  processes.set(svc.code, spawned);
  logger.info(
    { code: svc.code, pid: child.pid, restartCount, detached, version: childEnv[SERVICE_VERSION_ENV] },
    'spawned (windowless)',
  );

  const runningState = updateInstanceStatus(svc.code, 'running', child.pid ?? null, undefined, spawnedAt);

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
      await updateInstanceStatus(code, alive ? 'crashed' : 'stopped', null);
      if (!alive) return true;
      throw new Error(`refusing to stop stale or unverified adopted process ${code} pid=${a.pid}`);
    }
    await treeKill(a.pid);
    adopted.delete(code);
    await updateInstanceStatus(code, 'stopped', null, 0);
    return true;
  }
  if (pendingSpawn?.failure) throw pendingSpawn.failure;
  return canceledRestart;
}

/**
 * 終了させられなかった (= 生きている) spawn を捨てずに adopted へ載せ、失敗を
 * pending settlement へ伝える。child / job-breakaway の両戦略で共用する。
 */
function retainRejectedSpawn(code: string, pid: number | undefined, startedAt: Date, error: unknown): void {
  const failure = error instanceof Error ? error : new Error(String(error));
  const settlement = spawnSettlements.get(code);
  if (settlement) settlement.failure = failure;
  if (pid) adopted.set(code, { code, pid, startedAt });
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
    // taskkill has completed synchronously. Polling the numeric PID after this
    // point can observe an unrelated process that Windows has already assigned
    // the same PID to, turning a successful stop into a grace-period timeout.
    return;
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

  await updateInstanceStatus(svc.code, intentionalStop || cleanExit ? 'stopped' : 'crashed', null, code ?? undefined);

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

/**
 * 子へ継承させない supervisor 固有の credential。
 *
 * supervisor は起動時に `applyInfisicalToEnv()` で **Excubitor 自身の** machine identity を
 * `process.env` へ載せる (service-runner-infisical.ts)。 この identity は Excubitor が
 * アクセスできる全 Infisical project を読める鍵なので、 素通しで継承させると relay が
 * `inject` / `requires_secret` で project・key 単位に絞っている意味が無くなる
 * (子は自分に配られた secret 以外も自力で fetch できてしまう)。 Cernere の issuer
 * credential を prepareSpawnEnv が削除するのと同じ扱いにする。
 *
 * SITE_URL / ENVIRONMENT は機密でなく、 自前 fetch するサービスの接続先として有用なので残す。
 */
const NON_INHERITABLE_ENV_KEYS = ['INFISICAL_CLIENT_ID', 'INFISICAL_CLIENT_SECRET'];

/** spawn 子へ渡す継承 env (undefined と supervisor 固有 credential を落とす)。 */
export function inheritableSupervisorEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' && !NON_INHERITABLE_ENV_KEYS.includes(entry[0]),
    ),
  );
}

/** 実行時の spawn 戦略。EXCUBITOR_SPAWN_STRATEGY で明示上書き (不正値は fail-fast)。 */
function resolveSpawnStrategy(): 'child' | 'job-breakaway' {
  const override = process.env.EXCUBITOR_SPAWN_STRATEGY;
  if (override === undefined || override === '') {
    return process.platform === 'win32' ? 'job-breakaway' : 'child';
  }
  if (override === 'child' || override === 'job-breakaway') return override;
  throw new Error(`EXCUBITOR_SPAWN_STRATEGY must be "child" or "job-breakaway": ${override}`);
}

// WMI 経由 spawn は powershell と launcher の起動を挟むため、作成時刻の照合は spawn 前後の
// 時計ずれを許容する (通常の adopt 照合の 5s では負荷時に誤検知しうる)。
const BREAKAWAY_START_TOLERANCE_MS = 30_000;
const BREAKAWAY_IDENTITY_WAIT_MS = 3_000;
const BREAKAWAY_IDENTITY_RETRY_INTERVAL_MS = 100;

/**
 * Job Object の外で起動し、adopted (pid 管理) として登録する。クラッシュ再起動は
 * AdoptedProcessReaper (validateManagedProcess 失敗 → catalog 準拠の再起動) が担う。
 */
async function spawnBreakawayService(
  svc: Service,
  opts: SpawnOptions,
  generation: number,
  childEnv: Record<string, string>,
  resolvedCwd: string | undefined,
  command: { command: string; args: string[]; shell: boolean },
): Promise<SpawnedProcess> {
  // 前回 child 戦略の fd が残っていれば閉じる。breakaway ではログの fd を短命 launcher が
  // 開いて子へ渡すため、supervisor は fd を所有しない。
  stopProcessLog(svc.code);
  const { stdoutPath, stderrPath } = ensureProcessLogPaths(svc.code);
  const spawnedAt = new Date();
  let pid: number;
  try {
    ({ pid } = await spawnOutsideJob(
      {
        ...command,
        ...(resolvedCwd === undefined ? {} : { cwd: resolvedCwd }),
        env: childEnv,
        stdoutPath,
        stderrPath,
      },
      opts.breakaway ?? {},
    ));
  } catch (err) {
    await recordSpawnFailure(svc.code, err);
    throw err;
  }
  // 復旧 (reconcile/adopt) と同じ形で pid を先に永続化する。この直後に supervisor が
  // 死んでも boot 時の突合が拾える。
  await updateInstanceStatus(svc.code, 'pending', pid, undefined, spawnedAt);
  // launcher が返す PID は StartTime の可視化より先行しうるため、
  // 作成時刻つき照合だけを短時間リトライする。照合条件を緩めず、期限後は fail-closed。
  const identity = await waitForProcessIdentity(pid, spawnedAt, {
    toleranceMs: BREAKAWAY_START_TOLERANCE_MS,
    timeoutMs: BREAKAWAY_IDENTITY_WAIT_MS,
    retryIntervalMs: BREAKAWAY_IDENTITY_RETRY_INTERVAL_MS,
  });
  if (!identity) {
    // verifyProcessIdentity は「即死した」と「照合できなかった」を区別しない。
    // 後者なら pid は生きたまま残るため、§17.4 の孤児検出手順へ回せるよう pid を
    // 明示して警告する (成功として扱わないのは共通)。
    logger.warn(
      { code: svc.code, pid },
      'breakaway spawn could not be verified; pid may survive as an orphan (see design.md §17.4)',
    );
    const failure = new Error(
      `service ${svc.code} could not be verified after breakaway spawn (pid=${pid});`
        + ` it exited immediately or its identity was unreadable — check ${stderrPath}`,
    );
    // 照合できなかっただけで pid が生きているなら、それは孤児にしてよい実体ではない。
    // 失敗として返しつつ pid は残し、boot 時の reconcile と宣言ポート突合が拾えるようにする。
    await recordSpawnFailure(svc.code, failure, pid);
    throw failure;
  }
  // stop / shutdown とのレース: child 戦略の spawn 完了後 recheck と同じ扱い。
  // treeKill 完了までは pid が真実なので、消えてから 'stopped' へ落とす
  // (先に永続化した pending 行を残さない)。
  if (!isCurrentRunningGeneration(svc.code, generation)) {
    try {
      await treeKill(pid);
    } catch (cleanupError) {
      // 落とせなかった pid は生きている。child 戦略と同じく adopted に載せて
      // reaper / 次の stop が拾えるようにし、孤児にしない。
      retainRejectedSpawn(svc.code, pid, identity.startedAt, cleanupError);
      throw cleanupError;
    }
    await updateInstanceStatus(svc.code, 'stopped', null).catch((stateError: unknown) => {
      logger.error(
        { code: svc.code, err: (stateError as Error).message },
        'failed to record canceled breakaway spawn state',
      );
    });
    throw new Error(`service ${svc.code} start canceled by a newer lifecycle request`);
  }
  adopted.set(svc.code, { code: svc.code, pid, startedAt: identity.startedAt });
  await updateInstanceStatus(svc.code, 'running', pid, undefined, identity.startedAt);
  logger.info(
    { code: svc.code, pid, strategy: 'job-breakaway', version: childEnv[SERVICE_VERSION_ENV] },
    'spawned outside the supervisor job (windowless)',
  );
  return {
    code: svc.code,
    child: null,
    pid,
    startedAt: identity.startedAt,
    restartCount: opts.initialRestartCount ?? 0,
  };
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

/**
 * `survivingPid` は「起動は失敗扱いだが、その pid はまだ生きている」場合に渡す。
 *
 * pid を捨てて `crashed` にすると、生き残った実体へ Excubitor が二度と到達できなくなる
 * (停止も再起動も対象を持てず、次の起動は EADDRINUSE でしか失敗しない)。 失敗の記録と
 * pid の保持は両立させ、boot 時の reconcile が拾えるようにする。
 */
async function recordSpawnFailure(
  code: string,
  err: unknown,
  survivingPid?: number | null,
): Promise<void> {
  processes.delete(code);
  try {
    stopProcessLog(code);
  } catch (logErr) {
    logger.error({ code, err: (logErr as Error).message }, 'failed to close process log after spawn failure');
  }
  const message = err instanceof Error ? err.message : String(err);
  const retained = typeof survivingPid === 'number' && isPidAlive(survivingPid)
    ? survivingPid
    : null;
  logger.error({ code, err: message, retainedPid: retained }, 'spawn failed');
  try {
    await updateInstanceStatus(code, 'crashed', retained);
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
  // taskkill /T has already synchronously completed on Windows. Checking the
  // numeric PID again can observe a newly reused PID and unnecessarily hold a
  // completed ChildProcess shutdown until the grace timeout expires.
  if (process.platform === 'win32') {
    return withBooleanTimeout(processEntry.termination, timeoutMs);
  }
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

async function updateInstanceStatus(
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
