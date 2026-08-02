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
 * ホスト) の下で生成されるため、呼び出し元の Job に入らない。生成後は pid だけを
 * 受け取り、既存の adopted-process 系 (pid 監視 / taskkill /T / reaper 再起動) で
 * 管理する。
 *
 * 機密の扱い: 子の env には起動 credential が含まれるため、コマンドラインには
 * 一切載せない。spec 全体を base64 JSON にして PowerShell の **stdin** に流し、
 * Win32_ProcessStartup.EnvironmentVariables で渡す。
 */
import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 20_000;

/** Win32_Process.Create の ReturnValue → 人間が読める理由。 */
const CREATE_RETURN_REASONS: Record<number, string> = {
  2: 'access denied',
  3: 'insufficient privilege',
  8: 'unknown failure',
  9: 'path not found',
  21: 'invalid parameter',
};

export interface BreakawaySpawnSpec {
  /** 子として実行する生のコマンドライン (リダイレクトは builder が付ける)。 */
  commandLine: string;
  cwd?: string;
  /** 子プロセスの環境変数一式 (継承ではなく全置換)。 */
  env: Record<string, string>;
  stdoutPath: string;
  stderrPath: string;
}

export interface BreakawaySpawnResult {
  pid: number;
}

export interface BreakawaySpawnOptions {
  timeoutMs?: number;
  /** テスト用: PowerShell 実行の差し替え。 */
  runPowerShell?: (script: string, timeoutMs: number) => Promise<string>;
}

/**
 * cmd.exe のコマンドラインへ 1 トークンを安全に載せる。
 * runtime=app のように child 戦略では shell を介さず (= 空白入りの exec パスが
 * そのまま渡る) 起動する経路で、breakaway 側も同じ引数分割になるよう引用する。
 * 埋め込みの `"` は `/d /s /c "..."` の外側引用符と区別できないため fail-fast。
 */
export function quoteWindowsArgument(value: string): string {
  if (value.includes('"')) {
    throw new Error(`breakaway spawn cannot quote an argument containing a double quote: ${value}`);
  }
  // cmd.exe は引用符の内側でも `%VAR%` を展開する。引用では防げないため、child 戦略
  // (shell:false) なら素通りしていた値が静かに書き換わる。silent corruption を作らない。
  if (value.includes('%')) {
    throw new Error(`breakaway spawn cannot pass an argument containing '%' through cmd.exe: ${value}`);
  }
  return value.length === 0 || /[\s&|<>^()]/.test(value) ? `"${value}"` : value;
}

/**
 * コマンドラインへ append リダイレクトを付けて cmd.exe 経由の 1 行にする。
 * `/d /s /c` は node の shell:true と同じ解釈規則 (外側の二重引用符を保持)。
 */
export function buildRedirectedCommandLine(
  commandLine: string,
  stdoutPath: string,
  stderrPath: string,
): string {
  const command = commandLine.trim();
  if (command.length === 0) throw new Error('breakaway spawn requires a non-empty command line');
  // ログパスは catalog の service code 由来。`"` が混ざるとリダイレクト先ではなく
  // 追加のコマンドとして解釈されうるため、組み立て前に弾く。
  for (const target of [stdoutPath, stderrPath]) {
    if (target.includes('"')) {
      throw new Error(`breakaway spawn log path must not contain a double quote: ${target}`);
    }
  }
  return `cmd.exe /d /s /c "${command} 1>>"${stdoutPath}" 2>>"${stderrPath}""`;
}

/** spec を埋め込んだ PowerShell スクリプト (stdin 渡し) を組み立てる。 */
export function buildCreateScript(spec: BreakawaySpawnSpec): string {
  const payload = {
    commandLine: buildRedirectedCommandLine(spec.commandLine, spec.stdoutPath, spec.stderrPath),
    cwd: spec.cwd ?? null,
    env: Object.entries(spec.env).map(([key, value]) => `${key}=${value}`),
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  return [
    "$ErrorActionPreference = 'Stop'",
    `$spec = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json`,
    // ShowWindow=0 (SW_HIDE): cmd.exe のコンソール窓を出さない (windowsHide 相当)。
    '$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{',
    '  ShowWindow = [UInt16]0',
    '  EnvironmentVariables = [string[]]$spec.env',
    '}',
    '$arguments = @{ CommandLine = $spec.commandLine; ProcessStartupInformation = $startup }',
    'if ($null -ne $spec.cwd) { $arguments.CurrentDirectory = $spec.cwd }',
    '$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments $arguments',
    '@{ ReturnValue = $result.ReturnValue; ProcessId = $result.ProcessId } | ConvertTo-Json -Compress',
  ].join('\n');
}

/** PowerShell 出力 (JSON) を検証して pid を取り出す。 */
export function parseCreateOutput(output: string): BreakawaySpawnResult {
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

/**
 * Job Object の外でプロセスを起動し pid を返す。失敗は throw (無言 fallback 禁止)。
 */
export async function spawnOutsideJob(
  spec: BreakawaySpawnSpec,
  options: BreakawaySpawnOptions = {},
): Promise<BreakawaySpawnResult> {
  const run = options.runPowerShell ?? runPowerShellViaStdin;
  const output = await run(buildCreateScript(spec), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  return parseCreateOutput(output);
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
