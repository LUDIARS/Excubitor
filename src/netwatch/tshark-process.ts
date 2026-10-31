/** @implements SPEC-EX-NETWATCH */
/**
 * tshark の子プロセス 1 本の寿命を持つ。 stdout は UTF-8 の行として渡し、 stderr は
 * 診断として末尾だけ控える (データ用の stdout に診断を混ぜない)。 終了は必ず onExit で知らせる。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';

const STDERR_TAIL_LINES = 20;

export interface TsharkProcessOptions {
  executable: string;
  args: string[];
  onLine: (line: string) => void;
  onExit: (result: { code: number | null; signal: NodeJS.Signals | null; error: Error | null }) => void;
}

export class TsharkProcess {
  readonly stderrTail: string[] = [];
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutLines: Interface | null = null;
  private stderrLines: Interface | null = null;
  private exited = false;

  constructor(private readonly options: TsharkProcessOptions) {}

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  start(): void {
    if (this.child) throw new Error('tshark process already started');
    const child = spawn(this.options.executable, this.options.args, {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdin.end();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    this.stdoutLines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.stdoutLines.on('line', (line) => this.options.onLine(line));
    this.stderrLines = createInterface({ input: child.stderr, crlfDelay: Infinity });
    this.stderrLines.on('line', (line) => this.rememberStderr(line));
    // spawn 失敗 (ENOENT など) は exit が来ないことがあるので error でも終了として扱う。
    child.once('error', (error) => this.finish(null, null, error));
    child.once('exit', (code, signal) => this.finish(code, signal, null));
  }

  stop(): void {
    if (!this.child || this.exited) return;
    this.child.kill();
  }

  private rememberStderr(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    this.stderrTail.push(trimmed);
    if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift();
  }

  private finish(code: number | null, signal: NodeJS.Signals | null, error: Error | null): void {
    if (this.exited) return;
    this.exited = true;
    this.stdoutLines?.close();
    this.stderrLines?.close();
    this.options.onExit({ code, signal, error });
  }
}
