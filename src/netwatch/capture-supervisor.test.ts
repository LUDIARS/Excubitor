/** @implements SPEC-EX-NETWATCH */
import { describe, expect, it } from 'vitest';
import { CaptureSupervisor } from './capture-supervisor.js';
import type { CaptureSettings } from './settings.js';
import type { TsharkProcessOptions } from './tshark-process.js';

class FakeProcess {
  readonly stderrTail: string[] = [];
  started = false;
  stopped = false;
  failOnStart: Error | null = null;
  constructor(readonly options: TsharkProcessOptions, readonly pid: number) {}
  start(): void {
    if (this.failOnStart) throw this.failOnStart;
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
  }
  exit(code: number | null, error: Error | null = null): void {
    this.options.onExit({ code, signal: null, error });
  }
}

function settings(overrides: Partial<CaptureSettings> = {}): CaptureSettings {
  return {
    executable: 'tshark', args: ['-i', '1'], homeCountry: 'JP', maxDestinations: 10, dnsTtlMs: 1_000,
    restartAfterMs: 60_000, retryAfterMs: 30_000, fingerprint: 'a', ...overrides,
  };
}

function harness() {
  let now = 0;
  const processes: FakeProcess[] = [];
  const lines: string[] = [];
  let starts = 0;
  const supervisor = new CaptureSupervisor({
    createProcess: (options) => {
      const child = new FakeProcess(options, processes.length + 100);
      processes.push(child);
      return child;
    },
    onLine: (line) => lines.push(line),
    onStart: () => { starts += 1; },
    now: () => now,
    log: () => { /* テストでは捨てる */ },
  });
  const counters = { publicObserved: 0, publicWithoutCountry: 0 };
  return {
    supervisor, processes, lines,
    starts: () => starts,
    advance: (ms: number) => { now += ms; },
    status: () => supervisor.status(counters),
  };
}

describe('CaptureSupervisor', () => {
  it('設定が無ければ起動せず、 理由つきで disabled', () => {
    const h = harness();
    h.supervisor.reconcile(null, 'EXCUBITOR_NETWATCH_INTERFACE 未設定');
    expect(h.processes).toHaveLength(0);
    expect(h.status()).toMatchObject({ state: 'disabled', reason: 'EXCUBITOR_NETWATCH_INTERFACE 未設定' });
  });

  it('起動して行を渡し、 同じ設定では起動し直さない', () => {
    const h = harness();
    h.supervisor.reconcile(settings(), null);
    h.processes[0]!.options.onLine('row');
    h.supervisor.reconcile(settings(), null);
    expect(h.processes).toHaveLength(1);
    expect(h.lines).toEqual(['row']);
    expect(h.status()).toMatchObject({ state: 'running', pid: 100 });
    expect(h.starts()).toBe(1);
  });

  it('異常終了は stderr の末尾を理由にして待ち、 待ちが明けたら起動し直す', () => {
    const h = harness();
    h.supervisor.reconcile(settings(), null);
    h.processes[0]!.stderrTail.push('Capture interface not found');
    h.processes[0]!.exit(1);
    expect(h.status()).toMatchObject({ state: 'backoff', stderrTail: ['Capture interface not found'] });
    expect(h.status().reason).toMatch(/code=1.*Capture interface not found/);
    h.advance(10_000);
    h.supervisor.reconcile(settings(), null);
    expect(h.processes).toHaveLength(1);
    h.advance(20_000);
    h.supervisor.reconcile(settings(), null);
    expect(h.processes).toHaveLength(2);
  });

  it('起動できない (ENOENT) ときも backoff にする', () => {
    const h = harness();
    const original = h.supervisor;
    original.reconcile(settings({ executable: 'missing' }), null);
    // FakeProcess.start は成功するので、 起動時の例外は error 付きの exit として伝える。
    h.processes[0]!.exit(null, new Error('spawn missing ENOENT'));
    expect(h.status().reason).toMatch(/起動できない: spawn missing ENOENT/);
  });

  it('設定が変わったら止めて、 終了を受けてから新しい設定で起動する', () => {
    const h = harness();
    h.supervisor.reconcile(settings(), null);
    h.supervisor.reconcile(settings({ fingerprint: 'b' }), null);
    expect(h.processes[0]!.stopped).toBe(true);
    expect(h.processes).toHaveLength(1);
    h.processes[0]!.exit(null);
    expect(h.status().state).toBe('starting');
    h.supervisor.reconcile(settings({ fingerprint: 'b' }), null);
    expect(h.processes).toHaveLength(2);
  });

  it('決めた時間を過ぎたら止めてから起動し直す (二重に数えない)', () => {
    const h = harness();
    h.supervisor.reconcile(settings(), null);
    h.advance(60_000);
    h.supervisor.reconcile(settings(), null);
    expect(h.processes[0]!.stopped).toBe(true);
    expect(h.processes).toHaveLength(1);
    h.processes[0]!.exit(0);
    h.supervisor.reconcile(settings(), null);
    expect(h.processes).toHaveLength(2);
    expect(h.starts()).toBe(2);
  });

  it('止めた後の古いプロセスの行と終了は無視する', () => {
    const h = harness();
    h.supervisor.reconcile(settings(), null);
    const old = h.processes[0]!;
    h.supervisor.reconcile(null, 'off');
    old.exit(null);
    h.supervisor.reconcile(settings(), null);
    old.options.onLine('stale');
    expect(h.lines).toEqual([]);
    expect(h.status().state).toBe('running');
  });

  it('fail は止めて failed と理由を出す', () => {
    const h = harness();
    h.supervisor.reconcile(settings(), null);
    h.supervisor.fail('設定が不正: x');
    expect(h.processes[0]!.stopped).toBe(true);
    expect(h.status()).toMatchObject({ state: 'failed', reason: '設定が不正: x' });
  });
});
