/** @implements SPEC-EX-NETWATCH */
/**
 * tshark の起動・停止・異常終了後の待機・定期的な起動し直しを持ち、 状態を CaptureStatus で公開する。
 * 何を動かすかは reconcile() に渡された設定で決め、 自分では設定を読まない。
 */

import type { CaptureSettings } from './settings.js';
import type { TsharkProcess, TsharkProcessOptions } from './tshark-process.js';
import type { CaptureState, CaptureStatus } from './types.js';

export type TsharkFactory = (options: TsharkProcessOptions) => Pick<TsharkProcess, 'start' | 'stop' | 'pid' | 'stderrTail'>;

export interface CaptureSupervisorDeps {
  createProcess: TsharkFactory;
  onLine: (line: string) => void;
  /** 起動し直すたびに呼ぶ (カウンタの初期化など)。 */
  onStart: () => void;
  now: () => number;
  log: (level: 'info' | 'warn', message: string, detail: Record<string, unknown>) => void;
}

type Running = ReturnType<TsharkFactory>;

export class CaptureSupervisor {
  private process: Running | null = null;
  private settings: CaptureSettings | null = null;
  private state: CaptureState = 'disabled';
  private reason: string | null = null;
  private startedAtMs: number | null = null;
  private retryAtMs: number | null = null;
  private lastStderr: string[] = [];
  /** 自分で止めた終了 (設定変更・定期の起動し直し・停止) は異常終了として扱わない。 */
  private stopping = false;

  constructor(private readonly deps: CaptureSupervisorDeps) {}

  /** 望む設定に合わせる。 null なら止めて disabled にする。 周期的に呼ぶ。 */
  reconcile(settings: CaptureSettings | null, disabledReason: string | null): void {
    if (!settings) {
      this.stopProcess();
      this.settings = null;
      this.state = 'disabled';
      this.reason = disabledReason;
      this.retryAtMs = null;
      return;
    }
    const changed = this.settings?.fingerprint !== settings.fingerprint;
    this.settings = settings;
    if (changed) {
      this.retryAtMs = null;
      if (this.process) {
        this.stopProcess();
        return; // 終了通知を受けてから次の reconcile で起動する。
      }
    }
    if (this.process) {
      this.rotateIfDue(settings);
      return;
    }
    if (this.retryAtMs !== null && this.deps.now() < this.retryAtMs) return;
    this.startProcess(settings);
  }

  /** 失敗を外から伝える (設定が組み立てられなかったなど)。 tshark は止める。 */
  fail(reason: string): void {
    this.stopProcess();
    this.settings = null;
    this.state = 'failed';
    this.reason = reason;
  }

  stop(): void {
    this.stopProcess();
    this.state = 'disabled';
    this.reason = 'stopped';
  }

  status(counters: { publicObserved: number; publicWithoutCountry: number }): CaptureStatus {
    return {
      state: this.state,
      reason: this.reason,
      pid: this.process?.pid ?? null,
      startedAtMs: this.startedAtMs,
      stderrTail: [...(this.process?.stderrTail ?? this.lastStderr)],
      publicObserved: counters.publicObserved,
      publicWithoutCountry: counters.publicWithoutCountry,
    };
  }

  private rotateIfDue(settings: CaptureSettings): void {
    if (settings.restartAfterMs <= 0 || this.startedAtMs === null) return;
    if (this.deps.now() - this.startedAtMs < settings.restartAfterMs) return;
    this.deps.log('info', 'netwatch: rotating tshark', { pid: this.process?.pid ?? null });
    // 古い方を止めてから起動する。 2 本同時に流すと同じパケットを二重に数えるため。
    this.stopProcess();
  }

  private startProcess(settings: CaptureSettings): void {
    this.state = 'starting';
    this.reason = null;
    this.stopping = false;
    const child = this.deps.createProcess({
      executable: settings.executable,
      args: settings.args,
      onLine: (line) => {
        if (this.process !== child) return;
        this.state = 'running';
        this.deps.onLine(line);
      },
      onExit: (result) => this.handleExit(child, result),
    });
    this.process = child;
    this.startedAtMs = this.deps.now();
    this.deps.onStart();
    try {
      child.start();
    } catch (error) {
      this.handleExit(child, { code: null, signal: null, error: error as Error });
      return;
    }
    // tshark は最初のパケットまで何も出さない。 起動できた時点で running とする。
    if (this.process === child) this.state = 'running';
  }

  private handleExit(
    child: Running,
    result: { code: number | null; signal: NodeJS.Signals | null; error: Error | null },
  ): void {
    if (this.process !== child) return;
    this.lastStderr = [...child.stderrTail];
    this.process = null;
    this.startedAtMs = null;
    if (this.stopping) {
      this.stopping = false;
      if (this.state !== 'disabled' && this.state !== 'failed') this.state = 'starting';
      return;
    }
    const why = result.error
      ? `tshark を起動できない: ${result.error.message}`
      : `tshark が終了した (code=${result.code ?? 'null'} signal=${result.signal ?? 'null'})`;
    const detail = this.lastStderr.at(-1);
    this.reason = detail ? `${why}: ${detail}` : why;
    this.state = 'backoff';
    this.retryAtMs = this.deps.now() + (this.settings?.retryAfterMs ?? 30_000);
    this.deps.log('warn', 'netwatch: tshark exited', { reason: this.reason });
  }

  private stopProcess(): void {
    if (!this.process) return;
    this.stopping = true;
    this.process.stop();
  }
}
