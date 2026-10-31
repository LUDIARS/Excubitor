/** @implements SPEC-EX-NETWATCH */
/**
 * 接続表を周期で読み、 送信元プロセスの突き合わせ (OwnerAttribution) に渡す。
 * 表の読み取りは 1 回ずつ (前の回が終わるまで次を始めない)。 読めなければ理由を出し、
 * 別のコマンドを試しに行かない。
 */

import { execCapture } from '../shared/exec.js';
import { ConnectionTable, parseNetstat } from './connection-table.js';
import type { OwnerAttribution } from './owner-attribution.js';
import { OwnerResolver, type ProcessRow, type ServiceRoot } from './owner-resolver.js';

const NETSTAT_TIMEOUT_MS = 10_000;

export type AttributionState = 'off' | 'running' | 'failed' | 'unsupported';

export interface AttributionStatus {
  state: AttributionState;
  reason: string | null;
  /** 最後に表を読めた時刻 (epoch ms)。 */
  lastRefreshMs: number | null;
}

export interface ConnectionPollerDeps {
  attribution: OwnerAttribution;
  /** 接続表 (`netstat -ano` の出力)。 読めなければ null。 */
  readConnections: () => Promise<string | null>;
  /** プロセス一覧 (pid / ppid / 名前)。 まだ無ければ null。 */
  listProcesses: () => readonly ProcessRow[] | null;
  /** Excubitor が起動・採用したサービスの根プロセス。 */
  listServiceRoots: () => readonly ServiceRoot[];
  now: () => number;
}

/** Windows の接続表を読む。 他の OS では使わない (runtime 側で unsupported にする)。 */
export async function readNetstat(): Promise<string | null> {
  const result = await execCapture('netstat', ['-ano'], process.cwd(), NETSTAT_TIMEOUT_MS);
  return result.ok ? result.stdout : null;
}

export class ConnectionPoller {
  private timer: NodeJS.Timeout | null = null;
  private intervalMs = 0;
  private inFlight = false;
  private current: AttributionStatus = { state: 'off', reason: null, lastRefreshMs: null };

  constructor(private readonly deps: ConnectionPollerDeps) {}

  status(): AttributionStatus {
    return { ...this.current };
  }

  /** 周期を合わせて動かす。 同じ周期で動いていれば何もしない。 */
  start(intervalMs: number): void {
    if (this.timer && this.intervalMs === intervalMs) return;
    this.clearTimer();
    this.intervalMs = intervalMs;
    this.current = { ...this.current, state: 'running', reason: null };
    void this.poll();
    this.timer = setInterval(() => { void this.poll(); }, intervalMs);
    this.timer.unref();
  }

  /** 止める。 理由があれば unsupported / off の説明として残す。 */
  stop(state: 'off' | 'unsupported', reason: string | null): void {
    this.clearTimer();
    this.deps.attribution.reset();
    this.current = { state, reason, lastRefreshMs: this.current.lastRefreshMs };
  }

  private clearTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.intervalMs = 0;
  }

  private async poll(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const text = await this.deps.readConnections();
      // 読んでいる間に止められたら結果を捨てる。
      if (!this.timer) return;
      if (text === null) {
        this.current = { ...this.current, state: 'failed', reason: '接続表 (netstat -ano) を読めなかった' };
        return;
      }
      const resolver = new OwnerResolver(this.deps.listProcesses() ?? [], this.deps.listServiceRoots());
      const nowMs = this.deps.now();
      this.deps.attribution.refresh(new ConnectionTable(parseNetstat(text)), resolver, nowMs);
      this.current = { state: 'running', reason: null, lastRefreshMs: nowMs };
    } catch (error) {
      this.current = { ...this.current, state: 'failed', reason: (error as Error).message };
    } finally {
      this.inFlight = false;
    }
  }
}
