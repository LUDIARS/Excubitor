/**
 * Scheduled Task の Job Object から脱出してプロセスを起動する (win32 専用)。
 * 正本: spec/plan/design.md §17 (win32 job-breakaway spawn)。
 *
 * 背景: local-control supervisor は OS service manager (Scheduled Task) 配下で
 * 動き、Task Scheduler は起動プロセスを Job Object に入れる。子プロセスは
 * `detached: true` でも **Job を継承する** (detached は CREATE_NEW_PROCESS_GROUP /
 * DETACHED_PROCESS であって CREATE_BREAKAWAY_FROM_JOB ではない)。その結果、
 * supervisor が Task ごと止められる/死ぬと Job の tree-kill で全サービスが
 * 道連れになる (2026-08-02 実測: supervisor / backend / 全 managed service が
 * IsProcessInJob=true)。
 *
 * 脱出手段: WMI (Win32_Process.Create)。プロセスは WmiPrvSE (呼び出し元とは別の
 * ホスト) の下で生成されるため、呼び出し元の Job に入らない。
 *
 * ただし WMI は stdio のリダイレクトを持たない。以前はそれを
 * `cmd.exe /d /s /c "<command> 1>>out.log 2>>err.log"` で補っていたが、その cmd.exe は
 * サービスの生存期間ずっと居座り、cmd.exe の `>>` は書き込み共有を許さずにログを開く。
 * 取りこぼした旧インスタンスがログを掴んでいると次の起動は無出力のまま即死し、
 * 「即死したのか照合できないのか分からない」失敗になる (2026-08-08 GLab 起動不能)。
 * そこで **起動をコマンドラインで永続化するのをやめ** (neco 裁定 2026-08-08)、Job 外へ出すのは
 * 短命の launcher (breakaway-launcher.ts) だけにして、実プロセスは launcher が
 * Node の fd で起動する。ここが受け取る pid は launcher ではなく **実プロセス**の pid で、
 * 以後は既存の adopted-process 系 (pid 監視 / taskkill /T / reaper 再起動) で管理する。
 *
 * 機密の扱い: 子の env には起動 credential が含まれるため、コマンドラインには
 * 一切載せない。spec 全体を base64 JSON にして PowerShell の **stdin** に流し、
 * Win32_ProcessStartup.EnvironmentVariables で渡す。launcher へ渡す起動 spec も
 * env 経由 (`EXCUBITOR_BREAKAWAY_SPEC`) で、コマンドラインには node、source 実行時の
 * loader 登録、launcher のパスしか載らない。
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BREAKAWAY_SPEC_ENV, type BreakawayLaunchSpec } from './breakaway-launcher.js';

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RESULT_TIMEOUT_MS = 20_000;
const RESULT_POLL_INTERVAL_MS = 50;
const LOADER_OPTIONS_WITH_VALUE = new Set([
  '--experimental-loader',
  '--import',
  '--loader',
  '--require',
  '-r',
]);
const LOADER_OPTION_PREFIXES = [
  '--experimental-loader=',
  '--import=',
  '--loader=',
  '--require=',
];

const DEFAULT_RESULT_IO = {
  read: async (path: string): Promise<string | null> => {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  },
  remove: (path: string): Promise<void> => rm(path, { force: true }),
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Win32_Process.Create の ReturnValue → 人間が読める理由。 */
const CREATE_RETURN_REASONS: Record<number, string> = {
  2: 'access denied',
  3: 'insufficient privilege',
  8: 'unknown failure',
  9: 'path not found',
  21: 'invalid parameter',
};

export interface BreakawaySpawnSpec {
  /** 実行するコマンド (shell=false なら実行ファイルそのもの)。 */
  command: string;
  args: string[];
  /** npm / .bat 解決のため cmd.exe を挟むか (child 戦略の shell 判定と同じ)。 */
  shell: boolean;
  cwd?: string;
  /** 子プロセスの環境変数一式 (継承ではなく全置換)。 */
  env: Record<string, string>;
  stdoutPath: string;
  stderrPath: string;
}

export interface BreakawaySpawnResult {
  /** 実プロセスの pid (launcher の pid ではない)。 */
  pid: number;
}

export interface BreakawaySpawnOptions {
  timeoutMs?: number;
  /** launcher が結果を書くまで待つ上限。 */
  resultTimeoutMs?: number;
  /** テスト用: PowerShell 実行の差し替え。 */
  runPowerShell?: (script: string, timeoutMs: number) => Promise<string>;
  /** テスト用: 結果ファイル読み取りの差し替え (未生成なら null)。 */
  readResult?: (path: string) => Promise<string | null>;
  /** テスト用: 結果ファイル削除の差し替え。 */
  removeResult?: (path: string) => Promise<void>;
  /** テスト用: 待機の差し替え。 */
  sleep?: (ms: number) => Promise<void>;
  /** テスト用: 結果ファイル名の差し替え (既定は uuid)。 */
  resultPath?: string;
  /** テスト用: launcher 起動コマンドラインの差し替え。 */
  launcherCommandLine?: string;
}

/**
 * Win32_Process.Create のコマンドラインへ 1 トークンを安全に載せる。
 * cmd.exe を経由しないため `%` 展開は起きない。空白を含むパスだけ引用する。
 */
export function quoteCommandLineToken(value: string): string {
  if (value.includes('"')) {
    throw new Error(`breakaway spawn cannot quote an argument containing a double quote: ${value}`);
  }
  return value.length === 0 || /[\s]/.test(value) ? `"${value}"` : value;
}

/**
 * launcher を起動するコマンドラインを組み立てる。
 * supervisor が tsx 等の loader 付きで動いている場合 (dev) も launcher を実行できるよう、
 * selectLauncherExecArgv で選んだ loader 登録を受け取る。
 */
export function buildLauncherCommandLine(
  execPath: string,
  execArgv: string[],
  launcherPath: string,
): string {
  return [execPath, ...execArgv, launcherPath].map(quoteCommandLineToken).join(' ');
}

/**
 * source 実行に必要な loader 登録だけを launcher へ引き継ぐ。
 * `--watch` / `--inspect-brk` / `--test` 等まで渡すと、短命 launcher が常駐・停止したり
 * entrypoint を実行しなくなったりするため、supervisor の全 execArgv は継承しない。
 */
export function selectLauncherExecArgv(execArgv: string[]): string[] {
  const selected: string[] = [];
  for (let index = 0; index < execArgv.length; index += 1) {
    const option = execArgv[index]!;
    if (LOADER_OPTIONS_WITH_VALUE.has(option)) {
      const value = execArgv[index + 1];
      if (value === undefined) {
        throw new Error(`Node loader option ${option} is missing its value`);
      }
      selected.push(option, value);
      index += 1;
      continue;
    }
    if (LOADER_OPTION_PREFIXES.some((prefix) => option.startsWith(prefix))) {
      selected.push(option);
    }
  }
  return selected;
}

/** spec を埋め込んだ PowerShell スクリプト (stdin 渡し) を組み立てる。 */
export function buildCreateScript(params: {
  commandLine: string;
  cwd?: string;
  env: Record<string, string>;
}): string {
  const payload = {
    commandLine: params.commandLine,
    cwd: params.cwd ?? null,
    env: Object.entries(params.env).map(([key, value]) => `${key}=${value}`),
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  // 各行は完結したステートメントにする。`-Command -` (stdin) 経由の Windows PowerShell 5.1
  // は対話的入力処理のため、`@{` を行末に残す複数行ハッシュテーブルリテラルや複数行 try/catch
  // など「行末で継続する」構文を渡すと、エラーも例外も出さず exit code 0 で出力ゼロのまま
  // 終わる (実測 2026-08-03)。行ごとに閉じたステートメントへ畳んで対処する。
  return [
    "$ErrorActionPreference = 'Stop'",
    `$spec = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json`,
    // ShowWindow=0 (SW_HIDE): launcher のコンソール窓を出さない (windowsHide 相当)。
    '$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [UInt16]0; EnvironmentVariables = [string[]]$spec.env }',
    '$arguments = @{ CommandLine = $spec.commandLine; ProcessStartupInformation = $startup }',
    'if ($null -ne $spec.cwd) { $arguments.CurrentDirectory = $spec.cwd }',
    '$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments $arguments',
    '@{ ReturnValue = $result.ReturnValue; ProcessId = $result.ProcessId } | ConvertTo-Json -Compress',
  ].join('\n');
}

/** PowerShell 出力 (JSON) を検証して launcher の pid を取り出す。 */
export function parseCreateOutput(output: string): { pid: number } {
  const line = output
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith('{'))
    .at(-1);
  if (!line) throw new Error(`Win32_Process.Create returned no JSON result: ${bound(output)}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new Error(`Win32_Process.Create result is not valid JSON: ${bound(line)}`, { cause: error });
  }
  const record = parsed as { ReturnValue?: unknown; ProcessId?: unknown };
  if (record.ReturnValue !== 0) {
    const code = typeof record.ReturnValue === 'number' ? record.ReturnValue : -1;
    const reason = CREATE_RETURN_REASONS[code] ?? 'unrecognized return value';
    throw new Error(`Win32_Process.Create failed with ReturnValue=${String(record.ReturnValue)} (${reason})`);
  }
  if (typeof record.ProcessId !== 'number' || !Number.isSafeInteger(record.ProcessId) || record.ProcessId <= 0) {
    throw new Error(`Win32_Process.Create returned an invalid ProcessId: ${String(record.ProcessId)}`);
  }
  return { pid: record.ProcessId };
}

/** launcher が書いた結果 JSON を検証して実 pid を取り出す。 */
export function parseLaunchResult(json: string): { pid: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(`breakaway launcher result is not valid JSON: ${bound(json)}`, { cause: error });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('breakaway launcher result must be a JSON object');
  }
  const record = parsed as { pid?: unknown; error?: unknown };
  if (typeof record.error === 'string') {
    // launcher が理由を持っている場合は必ずそれを返す。「即死したように見える」で潰さない。
    throw new Error(`breakaway launcher could not start the service: ${bound(record.error)}`);
  }
  if (typeof record.pid !== 'number' || !Number.isSafeInteger(record.pid) || record.pid <= 0) {
    throw new Error(`breakaway launcher returned an invalid pid: ${String(record.pid)}`);
  }
  return { pid: record.pid };
}

/** launcher モジュール (実行入口) の絶対パス。dev の .ts / 本番の .js どちらでも解決する。 */
export function resolveLauncherPath(): string {
  const here = fileURLToPath(import.meta.url);
  const extension = here.endsWith('.ts') ? '.ts' : '.js';
  return join(dirname(here), `breakaway-launcher-main${extension}`);
}

/**
 * Job Object の外でプロセスを起動し、実プロセスの pid を返す。失敗は throw (無言 fallback 禁止)。
 */
export async function spawnOutsideJob(
  spec: BreakawaySpawnSpec,
  options: BreakawaySpawnOptions = {},
): Promise<BreakawaySpawnResult> {
  const run = options.runPowerShell ?? runPowerShellViaStdin;
  const readResult = options.readResult ?? DEFAULT_RESULT_IO.read;
  const removeResult = options.removeResult ?? DEFAULT_RESULT_IO.remove;
  const sleep = options.sleep ?? DEFAULT_RESULT_IO.sleep;
  // 結果ファイルはログと同じディレクトリに置く (supervisor が書ける場所として保証済み)。
  const resultPath =
    options.resultPath ?? join(dirname(spec.stdoutPath), `.breakaway-${randomUUID()}.json`);

  const launchSpec: BreakawayLaunchSpec = {
    command: spec.command,
    args: spec.args,
    shell: spec.shell,
    ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
    stdoutPath: spec.stdoutPath,
    stderrPath: spec.stderrPath,
    resultPath,
  };

  const commandLine =
    options.launcherCommandLine
    ?? buildLauncherCommandLine(
      process.execPath,
      selectLauncherExecArgv(process.execArgv),
      resolveLauncherPath(),
    );

  const launcherEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(spec.env)) {
    // Windows では大小文字違いも同じ env 名。catalog 側の値で制御 spec を上書きさせず、
    // launcher から実プロセスへ制御 spec が残る経路も作らない。
    if (key.toUpperCase() === BREAKAWAY_SPEC_ENV) continue;
    launcherEnv[key] = value;
  }
  launcherEnv[BREAKAWAY_SPEC_ENV] = Buffer.from(JSON.stringify(launchSpec), 'utf8').toString('base64');

  try {
    const output = await run(
      buildCreateScript({
        commandLine,
        ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
        env: launcherEnv,
      }),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    const launcher = parseCreateOutput(output);
    const json = await waitForLaunchResult(
      resultPath,
      options.resultTimeoutMs ?? DEFAULT_RESULT_TIMEOUT_MS,
      { readResult, sleep, launcherPid: launcher.pid },
    );
    return parseLaunchResult(json);
  } finally {
    // 成否にかかわらず残さない。読めなかった場合でも次の起動が古い結果を拾わない。
    await removeResult(resultPath).catch(() => undefined);
  }
}

async function waitForLaunchResult(
  resultPath: string,
  timeoutMs: number,
  deps: {
    readResult: (path: string) => Promise<string | null>;
    sleep: (ms: number) => Promise<void>;
    launcherPid: number;
  },
): Promise<string> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    const json = await deps.readResult(resultPath);
    if (json !== null) return json;
    if (Date.now() >= deadline) {
      throw new Error(
        `breakaway launcher (pid=${deps.launcherPid}) did not report a pid within ${timeoutMs}ms`,
      );
    }
    await deps.sleep(RESULT_POLL_INTERVAL_MS);
  }
}

function runPowerShellViaStdin(script: string, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const finish = (error: Error | null, value?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value ?? '');
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`breakaway spawn timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', (error) => finish(new Error(`failed to start powershell.exe: ${error.message}`)));
    child.once('close', (code) => {
      const out = Buffer.concat(stdout).toString('utf8');
      const detail = Buffer.concat(stderr).toString('utf8').trim();
      // `-Command -` は stdin のスクリプトが terminating error で落ちても exit 0 を
      // 返しうる (原因は stderr のみ)。結果 JSON が無い場合は stderr を診断に載せて
      // 失敗させる: 中身の無い "no JSON result" にして原因を捨てない。
      if (code === 0 && /^\s*\{/m.test(out)) {
        finish(null, out);
        return;
      }
      finish(
        new Error(
          `breakaway spawn powershell produced no result (exit code ${String(code)}): ${bound(detail || out)}`,
        ),
      );
    });
    child.stdin.end(script);
  });
}

/**
 * PowerShell はエラー時に「落ちた行」をそのまま stderr へ書く。その行には
 * base64 化した spec (= 起動 credential を含む env) が載っているため、診断へ
 * 転記する前に必ず落とす。base64 は可逆なので、ログに出た時点で漏洩と同じ。
 */
const ENCODED_PAYLOAD = /[A-Za-z0-9+/=]{64,}/g;

function bound(value: string, limit = 400): string {
  const redacted = value.replace(ENCODED_PAYLOAD, '[redacted]');
  return redacted.length <= limit ? redacted : `${redacted.slice(0, limit)}…`;
}
