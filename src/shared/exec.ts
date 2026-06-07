/**
 * 子プロセスを spawn して stdout を集める軽量ヘルパ (git / taskkill 等の短命コマンド用)。
 * scanner/git.ts の safeExec を共通化したもの。 失敗・timeout は null を返す。
 */

import { spawn } from 'node:child_process';

export interface ExecResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

/** stdout のみ欲しい簡易版。 失敗 (非 0 / error / timeout) は null。 */
export function safeExec(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs = 5000,
): Promise<string | null> {
  return execCapture(cmd, args, cwd, timeoutMs).then((r) => (r.ok ? r.stdout : null));
}

/** exit code / stderr も欲しい版。 */
export function execCapture(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs = 15000,
  shell = false,
): Promise<ExecResult> {
  return new Promise((resolveP) => {
    const proc = spawn(cmd, args, { cwd, shell });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (r: ExecResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveP(r);
    };
    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch { /* noop */ }
      finish({ ok: false, code: null, stdout, stderr: stderr + '\n[timeout]' });
    }, timeoutMs);
    proc.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    proc.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    proc.on('error', (err) => finish({ ok: false, code: null, stdout, stderr: err.message }));
    proc.on('close', (code) => finish({ ok: code === 0, code, stdout, stderr }));
  });
}
