import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { execCapture } from '../shared/exec.js';
import type { ExcubitorStatusPayload } from './protocol.js';

export interface ExcubitorBackendOptions {
  rootDir: string;
  spawnBackend?: (instanceToken: string) => ChildProcess;
  waitUntilReady?: (child: ChildProcess) => Promise<void>;
  readinessTimeoutMs?: number;
  readinessPollMs?: number;
  restartBaseDelayMs?: number;
  restartMaxDelayMs?: number;
  stopTimeoutMs?: number;
  forceStopTimeoutMs?: number;
  adoptedMonitorIntervalMs?: number;
  adoptedIdentityFailureThreshold?: number;
  healthMonitorIntervalMs?: number;
  healthFailureThreshold?: number;
  onStatus?: (status: ExcubitorStatusPayload) => void | Promise<void>;
  onError?: (error: Error) => void;
  isPidAlive?: (pid: number) => boolean;
  probeHealthIdentity?: () => Promise<{ pid?: unknown; instance_token?: unknown } | null>;
  terminateAdopted?: (pid: number) => Promise<void>;
}

type BackendState = ExcubitorStatusPayload['state'];

export class ExcubitorBackendController {
  private child: ChildProcess | null = null;
  private adoptedPid: number | null = null;
  private adoptedMonitor: NodeJS.Timeout | null = null;
  private adoptedMonitorChecking = false;
  private adoptedIdentityFailures = 0;
  private ownedMonitor: NodeJS.Timeout | null = null;
  private ownedMonitorChecking = false;
  private ownedHealthFailures = 0;
  private instanceToken: string | null = null;
  private state: BackendState = 'stopped';
  private desiredState: 'running' | 'stopped' = 'stopped';
  private restartCount = 0;
  private lastExitCode: number | null = null;
  private lastSignal: string | null = null;
  private lastError: string | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private lifecycleTail: Promise<void> = Promise.resolve();
  private statusTail: Promise<void> = Promise.resolve();
  private monitorGeneration = 0;
  private preserving = false;

  constructor(private readonly options: ExcubitorBackendOptions) {}

  status(): ExcubitorStatusPayload {
    return {
      kind: 'excubitor-status',
      state: this.state,
      desired_state: this.desiredState,
      pid: this.child?.pid ?? this.adoptedPid,
      restart_count: this.restartCount,
      last_exit_code: this.lastExitCode,
      last_signal: this.lastSignal,
      last_error: this.lastError,
      instance_token: this.instanceToken,
    };
  }

  adopt(previous: ExcubitorStatusPayload | undefined): Promise<boolean> {
    return this.runLifecycle(() => this.adoptInternal(previous));
  }

  /** Atomically recover an orphaned backend or start a replacement. */
  recover(previous: ExcubitorStatusPayload | undefined): Promise<ExcubitorStatusPayload> {
    this.preserving = false;
    return this.runLifecycle(async () => {
      if (previous?.desired_state === 'stopped') return this.recoverStopped(previous);
      if (await this.adoptInternal(previous)) return this.status();
      if (previous && await this.recoverPersistedRunning(previous)) return this.status();
      return this.startInternal();
    });
  }

  private async recoverPersistedRunning(previous: ExcubitorStatusPayload): Promise<boolean> {
    const token = previous.instance_token;
    if (!token) return false;
    const expectedPid = previous.pid;
    const candidateAlive = expectedPid !== null && this.pidIsAlive(expectedPid);
    if (!candidateAlive && !(previous.state === 'starting' && expectedPid === null)) return false;

    // A launch reservation is persisted before spawn, followed by pid/token
    // immediately after spawn. If the supervisor dies in either window, wait
    // for the reserved token to appear at health rather than racing a second
    // backend into the same port.
    const recoveredPid = await this.waitForPersistedIdentity(expectedPid, token);
    if (recoveredPid !== null) {
      await this.acceptAdoptedIdentity(recoveredPid, token, previous.restart_count);
      return true;
    }
    if (expectedPid !== null && this.pidIsAlive(expectedPid)) {
      this.adoptedPid = expectedPid;
      this.instanceToken = token;
      this.desiredState = 'running';
      this.state = 'crashed';
      this.restartCount = previous.restart_count;
      this.lastError = `persisted Excubitor pid=${expectedPid} is alive but health identity could not be verified; refusing replacement`;
      await this.emitStatus();
      this.startAdoptedMonitor();
      throw new Error(this.lastError);
    }
    this.instanceToken = null;
    return false;
  }

  private async recoverStopped(previous: ExcubitorStatusPayload): Promise<ExcubitorStatusPayload> {
    this.desiredState = 'stopped';
    this.cancelRestart();
    this.cancelOwnedMonitor();
    this.clearAdopted();
    this.restartCount = previous.restart_count;
    this.lastExitCode = previous.last_exit_code;
    this.lastSignal = previous.last_signal;
    this.lastError = previous.last_error;

    const pid = previous.pid ?? null;
    const token = previous.instance_token ?? null;
    if (pid && token && this.pidIsAlive(pid)) {
      const recoveredPid = await this.waitForPersistedIdentity(pid, token);
      if (recoveredPid === null && this.pidIsAlive(pid)) {
        this.adoptedPid = pid;
        this.instanceToken = token;
        this.state = 'crashed';
        this.lastError = `stopped Excubitor pid=${pid} is alive but health identity could not be verified; refusing to discard it`;
        await this.emitStatus();
        this.startAdoptedMonitor();
        throw new Error(this.lastError);
      }
      if (recoveredPid !== null) {
        this.adoptedPid = recoveredPid;
        this.instanceToken = token;
        this.state = 'stopping';
        // Persist the stopped intent before terminating an orphan so a crash
        // during recovery cannot turn the next supervisor boot into a restart.
        await this.emitStatus();
        try {
          await (this.options.terminateAdopted ?? terminatePid)(recoveredPid);
        } catch (error) {
          this.state = 'crashed';
          this.lastError = asError(error).message;
          await this.emitStatus();
          throw error;
        }
        this.clearAdopted();
      }
    }

    this.state = 'stopped';
    this.instanceToken = null;
    await this.emitStatus();
    return this.status();
  }

  private async adoptInternal(previous: ExcubitorStatusPayload | undefined): Promise<boolean> {
    const pid = previous?.pid ?? null;
    const token = previous?.instance_token ?? null;
    if (!pid || !token || !this.pidIsAlive(pid)) return false;
    if (!(await this.matchesHealthIdentity(pid, token))) return false;
    await this.acceptAdoptedIdentity(pid, token, previous?.restart_count ?? 0);
    return true;
  }

  private async acceptAdoptedIdentity(pid: number, token: string, restartCount: number): Promise<void> {
    this.child = null;
    this.adoptedPid = pid;
    this.instanceToken = token;
    this.desiredState = 'running';
    this.state = 'running';
    this.restartCount = restartCount;
    this.lastError = null;
    await this.emitStatus();
    this.startAdoptedMonitor();
  }

  start(): Promise<ExcubitorStatusPayload> {
    this.preserving = false;
    return this.runLifecycle(() => this.startInternal());
  }

  private async startInternal(): Promise<ExcubitorStatusPayload> {
    this.desiredState = 'running';
    this.cancelRestart();
    if (this.adoptedPid) {
      if (this.pidIsAlive(this.adoptedPid)) {
        const token = this.instanceToken;
        if (token && await this.matchesHealthIdentity(this.adoptedPid, token)) {
          this.state = 'running';
          this.lastError = null;
          await this.emitStatus();
          this.startAdoptedMonitor();
          return this.status();
        }
        throw new Error(`refusing to replace unverified live Excubitor pid=${this.adoptedPid}`);
      }
      this.clearAdopted();
    }
    if (this.child) {
      if (this.state === 'running' || this.state === 'starting') return this.status();
      await this.terminateChild(this.child);
      if (this.child) throw new Error('previous Excubitor backend could not be terminated');
    }
    if (!this.options.spawnBackend) {
      const occupant = await this.readHealthIdentity();
      if (occupant) {
        this.state = 'crashed';
        this.lastError = `Excubitor port is already served by unowned pid=${String(occupant.pid ?? 'unknown')}`;
        await this.emitStatus();
        throw new Error(this.lastError);
      }
    }

    this.state = 'starting';
    let child: ChildProcess;
    const instanceToken = randomUUID();
    this.instanceToken = instanceToken;
    try {
      // Persist the token before the external spawn side effect. Recovery can
      // then wait for this exact token even if no pid was published yet.
      await this.emitStatus();
    } catch (error) {
      const persistError = asError(error);
      this.state = 'crashed';
      this.restartCount += 1;
      this.lastError = `failed to persist Excubitor launch reservation: ${persistError.message}`;
      this.instanceToken = null;
      this.options.onError?.(persistError);
      this.scheduleRestart();
      throw persistError;
    }
    try {
      child = this.spawnBackend(instanceToken);
    } catch (error) {
      const spawnError = error instanceof Error ? error : new Error(String(error));
      this.state = 'crashed';
      this.restartCount += 1;
      this.lastError = spawnError.message;
      this.instanceToken = null;
      void this.emitStatus().catch((statusError: unknown) => {
        this.options.onError?.(asError(statusError));
      });
      this.options.onError?.(spawnError);
      this.scheduleRestart();
      throw spawnError;
    }
    this.child = child;
    child.once('error', (error) => this.handleSpawnError(child, error));
    child.once('exit', (code, signal) => this.handleExit(child, code, signal));

    try {
      if (!child.pid) await waitForSpawn(child);
      // A spawned backend can outlive the supervisor. Durably publish its
      // identity before readiness work so a supervisor crash can adopt it.
      await this.emitStatus();
      child.unref?.();
      const waitUntilReady = this.options.waitUntilReady ?? ((candidate) => this.waitForHealth(candidate));
      await waitUntilReady(child);
      if (this.child !== child) throw new Error('Excubitor backend exited before becoming ready');
      this.state = 'running';
      this.restartCount = 0;
      this.lastError = null;
      this.startOwnedMonitor(child, instanceToken);
      await this.emitStatus();
      return this.status();
    } catch (error) {
      const readinessError = error instanceof Error ? error : new Error(String(error));
      this.lastError = readinessError.message;
      this.options.onError?.(readinessError);
      if (this.child === child) {
        try {
          await this.terminateChild(child);
        } catch (terminationError) {
          this.state = 'crashed';
          this.lastError = `${readinessError.message}; cleanup failed: ${asError(terminationError).message}`;
          void this.emitStatus().catch((statusError: unknown) => {
            this.options.onError?.(asError(statusError));
          });
          this.scheduleRestart();
        }
      }
      throw readinessError;
    }
  }

  stop(): Promise<ExcubitorStatusPayload> {
    return this.runLifecycle(() => this.stopInternal());
  }

  private async stopInternal(): Promise<ExcubitorStatusPayload> {
    this.desiredState = 'stopped';
    this.cancelRestart();
    this.cancelOwnedMonitor();
    if (this.adoptedPid) {
      const pid = this.adoptedPid;
      const token = this.instanceToken;
      this.state = 'stopping';
      await this.emitStatus();
      try {
        if (!token || !(await this.matchesHealthIdentity(pid, token))) {
          throw new Error(`refusing to stop unverified adopted Excubitor pid=${pid}`);
        }
        await (this.options.terminateAdopted ?? terminatePid)(pid);
        this.clearAdopted();
        this.state = 'stopped';
        await this.emitStatus();
        return this.status();
      } catch (error) {
        this.state = 'crashed';
        this.lastError = asError(error).message;
        await this.emitStatus();
        throw error;
      }
    }
    const child = this.child;
    if (!child) {
      this.state = 'stopped';
      await this.emitStatus();
      return this.status();
    }

    this.state = 'stopping';
    await this.emitStatus();
    try {
      await this.terminateChild(child);
    } catch (error) {
      this.state = 'crashed';
      this.lastError = asError(error).message;
      await this.emitStatus();
      throw error;
    }
    if (this.child === child) this.child = null;
    this.state = 'stopped';
    await this.emitStatus();
    return this.status();
  }

  restart(): Promise<ExcubitorStatusPayload> {
    return this.runLifecycle(async () => {
      this.state = 'restarting';
      await this.emitStatus();
      await this.stopInternal();
      return this.startInternal();
    });
  }

  /**
   * Release supervisor-owned monitoring handles without changing backend
   * intent or terminating the detached backend. Explicit stop() remains the
   * only normal path that kills Ex.
   */
  preserveForSupervisorShutdown(): Promise<void> {
    // Invalidate health probes synchronously, before this lifecycle operation
    // queues behind anything already in flight. A completed stale probe must
    // never terminate or restart the backend after preservation was requested.
    this.preserving = true;
    this.monitorGeneration += 1;
    return this.runLifecycle(async () => {
      this.cancelRestart();
      this.cancelOwnedMonitor();
      this.cancelAdoptedMonitor();
      this.child?.unref?.();
      await this.emitStatus();
    });
  }

  private runLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycleTail.then(operation, operation);
    this.lifecycleTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private spawnBackend(instanceToken: string): ChildProcess {
    if (this.options.spawnBackend) return this.options.spawnBackend(instanceToken);
    return spawn(process.execPath, [join(this.options.rootDir, 'dist', 'server.js'), '--service'], {
      cwd: this.options.rootDir,
      env: {
        ...process.env,
        EXCUBITOR_SERVICE_MODE: '1',
        EXCUBITOR_SAFE_MODE: '0',
        EXCUBITOR_LIFECYCLE_OWNER: 'supervisor',
        EXCUBITOR_INSTANCE_TOKEN: instanceToken,
      },
      stdio: ['ignore', 'inherit', 'inherit'],
      // The backend must remain alive if the OS manager restarts only the
      // supervisor. On Windows this also breaks it out of the Scheduled Task
      // job; on POSIX it creates an independent process group.
      detached: true,
      windowsHide: true,
    });
  }

  private async waitForHealth(child: ChildProcess): Promise<void> {
    const timeoutMs = this.options.readinessTimeoutMs ?? 30_000;
    const pollMs = this.options.readinessPollMs ?? 100;
    const rawPort = Number(process.env.EXCUBITOR_PORT ?? 17332);
    if (!Number.isInteger(rawPort) || rawPort <= 0 || rawPort > 65_535) {
      throw new Error(`invalid EXCUBITOR_PORT: ${process.env.EXCUBITOR_PORT ?? ''}`);
    }
    const url = `http://127.0.0.1:${rawPort}/health`;
    const deadline = Date.now() + timeoutMs;
    let lastError = 'health endpoint did not respond';
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null || this.child !== child) {
        throw new Error(`Excubitor backend exited before health readiness (${lastError})`);
      }
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
        if (response.ok) {
          const health = await response.json() as { pid?: unknown; instance_token?: unknown };
          if (health.pid === child.pid && health.instance_token === this.instanceToken) return;
          lastError = 'health identity did not match the spawned backend';
        } else {
          lastError = `health returned HTTP ${response.status}`;
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await delay(pollMs);
    }
    throw new Error(`Excubitor backend health readiness timed out after ${timeoutMs}ms: ${lastError}`);
  }

  private async matchesHealthIdentity(pid: number, token: string): Promise<boolean> {
    const health = await this.readHealthIdentity();
    return health?.pid === pid && health.instance_token === token;
  }

  private async waitForPersistedIdentity(expectedPid: number | null, token: string): Promise<number | null> {
    const deadline = Date.now() + (this.options.readinessTimeoutMs ?? 30_000);
    const pollMs = this.options.readinessPollMs ?? 100;
    while (true) {
      const health = await this.readHealthIdentity();
      const healthPid = positiveInteger(health?.pid);
      if (
        healthPid !== null
        && health?.instance_token === token
        && (expectedPid === null || healthPid === expectedPid)
        && this.pidIsAlive(healthPid)
      ) return healthPid;
      if (expectedPid !== null && !this.pidIsAlive(expectedPid)) return null;
      if (Date.now() >= deadline) return null;
      await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())));
    }
  }

  private async readHealthIdentity(): Promise<{ pid?: unknown; instance_token?: unknown } | null> {
    if (this.options.probeHealthIdentity) return this.options.probeHealthIdentity();
    const rawPort = Number(process.env.EXCUBITOR_PORT ?? 17332);
    if (!Number.isInteger(rawPort) || rawPort <= 0 || rawPort > 65_535) return null;
    try {
      const response = await fetch(`http://127.0.0.1:${rawPort}/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (!response.ok) return null;
      return await response.json() as { pid?: unknown; instance_token?: unknown };
    } catch {
      return null;
    }
  }

  private async terminateChild(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const graceful = waitForExit(child, this.options.stopTimeoutMs ?? 10_000);
    const signaled = child.kill('SIGTERM');
    if (!signaled && child.exitCode === null && child.signalCode === null) {
      throw new Error(`failed to signal Excubitor backend pid=${child.pid ?? 'unknown'}`);
    }
    try {
      await graceful;
      return;
    } catch {
      const forced = child.kill('SIGKILL');
      if (!forced && child.exitCode === null && child.signalCode === null) {
        throw new Error(`failed to force-stop Excubitor backend pid=${child.pid ?? 'unknown'}`);
      }
      await waitForExit(child, this.options.forceStopTimeoutMs ?? 2_000);
    }
  }

  private handleSpawnError(child: ChildProcess, error: Error): void {
    if (this.child !== child) return;
    this.cancelOwnedMonitor();
    this.child = null;
    this.instanceToken = null;
    this.state = 'crashed';
    this.restartCount += 1;
    this.lastError = error.message;
    void this.emitStatus().catch((statusError: unknown) => {
      this.options.onError?.(asError(statusError));
    });
    this.options.onError?.(error);
    this.scheduleRestart();
  }

  private handleExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) return;
    this.cancelOwnedMonitor();
    this.child = null;
    this.instanceToken = null;
    this.lastExitCode = code;
    this.lastSignal = signal;
    if (this.desiredState === 'running') {
      this.state = 'crashed';
      this.restartCount += 1;
    } else {
      this.state = 'stopped';
    }
    void this.emitStatus().catch((error: unknown) => {
      this.options.onError?.(asError(error));
    });
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.preserving || this.desiredState !== 'running' || this.restartTimer) return;
    const base = this.options.restartBaseDelayMs ?? 1_000;
    const maximum = this.options.restartMaxDelayMs ?? 30_000;
    const delay = Math.min(maximum, base * 2 ** Math.max(0, this.restartCount - 1));
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.start().catch((error: unknown) => {
        const restartError = error instanceof Error ? error : new Error(String(error));
        this.options.onError?.(restartError);
        this.scheduleRestart();
      });
    }, delay);
    this.restartTimer.unref?.();
  }

  private cancelRestart(): void {
    if (!this.restartTimer) return;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private startAdoptedMonitor(): void {
    this.cancelAdoptedMonitor();
    this.adoptedIdentityFailures = 0;
    const generation = ++this.monitorGeneration;
    this.adoptedMonitor = setInterval(() => {
      if (this.adoptedMonitorChecking) return;
      this.adoptedMonitorChecking = true;
      void this.checkAdoptedIdentity(generation).catch((error: unknown) => {
        this.options.onError?.(asError(error));
      }).finally(() => {
        this.adoptedMonitorChecking = false;
      });
    }, this.options.adoptedMonitorIntervalMs ?? 1_000);
    this.adoptedMonitor.unref?.();
  }

  private startOwnedMonitor(child: ChildProcess, token: string): void {
    this.cancelOwnedMonitor();
    this.ownedHealthFailures = 0;
    const generation = ++this.monitorGeneration;
    this.ownedMonitor = setInterval(() => {
      if (this.ownedMonitorChecking) return;
      this.ownedMonitorChecking = true;
      void this.checkOwnedHealth(child, token, generation).catch((error: unknown) => {
        this.options.onError?.(asError(error));
      }).finally(() => {
        this.ownedMonitorChecking = false;
      });
    }, this.options.healthMonitorIntervalMs ?? 5_000);
    this.ownedMonitor.unref?.();
  }

  private async checkOwnedHealth(child: ChildProcess, token: string, generation: number): Promise<void> {
    if (this.preserving || generation !== this.monitorGeneration) return;
    if (this.child !== child || this.instanceToken !== token || this.state !== 'running') return;
    const pid = child.pid;
    const identityMatches = pid !== undefined && await this.matchesHealthIdentity(pid, token);
    if (this.preserving || generation !== this.monitorGeneration) return;
    if (this.child !== child || this.instanceToken !== token || this.state !== 'running') return;
    if (identityMatches) {
      this.ownedHealthFailures = 0;
      return;
    }
    this.ownedHealthFailures += 1;
    if (this.ownedHealthFailures < (this.options.healthFailureThreshold ?? 3)) return;
    const failures = this.ownedHealthFailures;
    if (this.ownedMonitor) clearInterval(this.ownedMonitor);
    this.ownedMonitor = null;
    await this.runLifecycle(async () => {
      if (this.preserving || generation !== this.monitorGeneration) return;
      if (this.child !== child || this.instanceToken !== token || this.desiredState !== 'running') return;
      this.state = 'crashed';
      this.lastError = `Excubitor backend health identity failed ${failures} consecutive checks`;
      await this.emitStatus();
      try {
        await this.terminateChild(child);
      } catch (error) {
        this.lastError = `${this.lastError}; cleanup failed: ${asError(error).message}`;
        this.restartCount += 1;
        await this.emitStatus();
        this.scheduleRestart();
      }
    });
  }

  private cancelOwnedMonitor(): void {
    if (this.ownedMonitor) clearInterval(this.ownedMonitor);
    this.ownedMonitor = null;
    this.ownedHealthFailures = 0;
    this.monitorGeneration += 1;
  }

  private async checkAdoptedIdentity(generation: number): Promise<void> {
    if (this.preserving || generation !== this.monitorGeneration) return;
    const pid = this.adoptedPid;
    const token = this.instanceToken;
    if (!pid || !token) return;
    const alive = this.pidIsAlive(pid);
    const identityMatches = alive && await this.matchesHealthIdentity(pid, token);
    if (this.preserving || generation !== this.monitorGeneration) return;
    if (this.adoptedPid !== pid || this.instanceToken !== token) return;
    if (identityMatches) {
      this.adoptedIdentityFailures = 0;
      if (this.desiredState === 'stopped') {
        await this.runLifecycle(async () => {
          if (this.preserving || generation !== this.monitorGeneration) return;
          if (this.adoptedPid !== pid || this.instanceToken !== token || this.desiredState !== 'stopped') return;
          this.state = 'stopping';
          await this.emitStatus();
          try {
            await (this.options.terminateAdopted ?? terminatePid)(pid);
            this.clearAdopted();
            this.state = 'stopped';
            this.lastError = null;
            await this.emitStatus();
          } catch (error) {
            this.state = 'crashed';
            this.lastError = asError(error).message;
            await this.emitStatus();
          }
        });
        return;
      }
      if (this.state !== 'running' && this.desiredState === 'running') {
        this.state = 'running';
        this.lastError = null;
        await this.emitStatus();
      }
      return;
    }
    if (alive) {
      this.adoptedIdentityFailures += 1;
      const threshold = this.options.adoptedIdentityFailureThreshold ?? 3;
      if (this.adoptedIdentityFailures < threshold) return;
      this.state = 'crashed';
      this.lastError = `adopted Excubitor pid=${pid} is alive but health identity failed ${this.adoptedIdentityFailures} consecutive checks; refusing replacement`;
      await this.emitStatus();
      return;
    }
    this.clearAdopted();
    if (this.desiredState === 'running') {
      this.state = 'crashed';
      this.restartCount += 1;
      await this.emitStatus();
      this.scheduleRestart();
    } else {
      this.state = 'stopped';
      this.lastError = null;
      await this.emitStatus();
    }
  }

  private cancelAdoptedMonitor(): void {
    if (this.adoptedMonitor) clearInterval(this.adoptedMonitor);
    this.adoptedMonitor = null;
    this.monitorGeneration += 1;
  }

  private clearAdopted(): void {
    this.cancelAdoptedMonitor();
    this.adoptedPid = null;
    this.instanceToken = null;
    this.adoptedIdentityFailures = 0;
  }

  private pidIsAlive(pid: number): boolean {
    return (this.options.isPidAlive ?? isPidAlive)(pid);
  }

  private emitStatus(): Promise<void> {
    const status = this.status();
    const write = this.statusTail.then(async () => {
      await this.options.onStatus?.(status);
    });
    // A failed write must not poison later status persistence. Callers still
    // receive this write's rejection and decide whether the transition can
    // safely continue.
    this.statusTail = write.catch(() => undefined);
    return write;
  }
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = (): void => {
      child.off('error', onError);
      resolve();
    };
    const onError = (error: Error): void => {
      child.off('spawn', onSpawn);
      reject(error);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function terminatePid(pid: number): Promise<void> {
  if (!isPidAlive(pid)) return;
  if (process.platform === 'win32') {
    const result = await execCapture('taskkill', ['/PID', String(pid), '/T', '/F'], process.cwd(), 10_000);
    if (!result.ok && isPidAlive(pid)) {
      throw new Error(`taskkill failed for adopted Excubitor pid=${pid}: ${result.stderr || result.code}`);
    }
  } else {
    process.kill(pid, 'SIGTERM');
    if (!(await waitForPidExit(pid, 10_000))) {
      process.kill(pid, 'SIGKILL');
    }
  }
  if (!(await waitForPidExit(pid, 5_000))) {
    throw new Error(`adopted Excubitor pid=${pid} did not terminate`);
  }
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isPidAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await delay(50);
  }
  return true;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      reject(new Error(`Excubitor backend did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    const onExit = (): void => {
      clearTimeout(timer);
      resolve();
    };
    child.once('exit', onExit);
  });
}
