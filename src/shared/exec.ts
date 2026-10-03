/**
 * 子プロセスを spawn して stdout を集める軽量ヘルパ (git / taskkill 等の短命コマンド用)。
 * scanner/git.ts の safeExec を共通化したもの。 失敗・timeout は null を返す。
 */

import { spawn } from 'node:child_process';

import { killProcessTree } from './kill-tree.js';

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
    const needsShell = shell || (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(cmd));
    const proc = spawn(cmd, args, { cwd, shell: needsShell, env: spawnEnvFor(cmd), windowsHide: true });
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
      killProcessTree(proc);
      finish({ ok: false, code: null, stdout, stderr: stderr + '\n[timeout]' });
    }, timeoutMs);
    proc.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    proc.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    proc.on('error', (err) => finish({ ok: false, code: null, stdout, stderr: err.message }));
    proc.on('close', (code) => finish({ ok: code === 0, code, stdout, stderr }));
  });
}

/**
 * 子プロセスへ渡す env。 git には `GIT_OPTIONAL_LOCKS=0` を足す。
 *
 * `git status` は読むだけでも index の stat 情報を書き戻すために `.git/index.lock` を取る
 * (optional lock)。 ここは timeout で子を木ごと kill するので、 負荷の高いときに status が
 * 時間切れになると lock を握ったまま死に、 0 バイトの index.lock が残って以後の commit /
 * Revisor の自動マージが「index.lock: File exists」で止まっていた (2026-10-03、 GLAB で 2 回・
 * ほか 7 リポで 9/26 からの残骸)。 optional lock を切っても commit / merge などの必須 lock は
 * 従来どおり取る。
 */
export function spawnEnvFor(cmd: string): NodeJS.ProcessEnv {
  const env = normalizedEnv();
  if (!isGitCommand(cmd)) return env;
  return { ...env, GIT_OPTIONAL_LOCKS: '0' };
}

function isGitCommand(cmd: string): boolean {
  const base = cmd.replace(/\\/g, '/').split('/').pop() ?? cmd;
  return /^git(?:\.exe)?$/i.test(base);
}

function normalizedEnv(): NodeJS.ProcessEnv {
  if (process.platform !== 'win32') return process.env;
  const env: NodeJS.ProcessEnv = {};
  let pathKey: string | null = null;
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toLowerCase() === 'path') {
      pathKey ??= key;
      continue;
    }
    env[key] = value;
  }
  const pathValue = process.env.Path ?? process.env.PATH ?? process.env.path;
  if (pathValue != null) env[pathKey ?? 'Path'] = pathValue;
  return env;
}
