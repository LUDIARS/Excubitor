/**
 * 窓の無いコンソールを持たせてサービスを起動する (win32 専用)。
 * 正本: spec/plan/design.md §17.7 (サービスに窓無しコンソールを持たせる)。
 *
 * 背景 (2026-10-11 実測): launcher は実プロセスを Node の `detached: true` で起動していた。
 * Windows でこれは DETACHED_PROCESS で、サービスは **コンソールを一切持たない**。
 * コンソールの無いプロセスが console app (git / cmd / powershell 等) を
 * `windowsHide` 無しで起動すると、OS はその子に新しいコンソールを確保し、窓を開く。
 * 既定のターミナルが Windows Terminal の環境では、SW_HIDE を付けたコンソールでも
 * Windows Terminal への引き渡し (OpenConsole -Embedding) が起き、窓が一瞬出る。
 * サービス側の spawn を 1 つずつ直しても、依存ライブラリや npm / tsx の中までは追えない。
 *
 * 対処: サービスを CreateProcessW の `CREATE_NO_WINDOW` で起動し、**窓の無いコンソール**を
 * 持たせる。子孫はこのコンソールを継承するので、新しいコンソールも窓も作られない。
 * Node の spawn は `detached` で DETACHED_PROCESS になり (CREATE_NO_WINDOW は無視される)、
 * `detached` 無しでは libuv が子を launcher の寿命に縛る Job (KILL_ON_JOB_CLOSE) に入れる。
 * どちらも使えないため、CreateProcessW を直接呼ぶ小さな PowerShell ヘルパーを挟む。
 * ヘルパーは launcher の libuv Job に入るが、その Job は SILENT_BREAKAWAY_OK なので、
 * ヘルパーが作った実プロセスは Job に入らず、launcher とヘルパーが終わっても生き残る。
 *
 * - ログ: ヘルパーが共有を許す append (FILE_SHARE_READ|WRITE|DELETE) で開き、std ハンドルとして渡す。
 *   cmd.exe の `>>` のようにログを排他しない (design.md §17.4)。
 * - 継承させるハンドルは PROC_THREAD_ATTRIBUTE_HANDLE_LIST で stdin(NUL)/stdout/stderr の 3 本に限る。
 *   ヘルパー自身の stdout パイプを子が掴むと、launcher が結果を読み終われなくなるため。
 * - 機密: 子の env (起動 credential を含む) はコマンドラインに載せず、ヘルパーの stdin に JSON で流す。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export interface HiddenConsoleSpawnRequest {
  command: string;
  args: string[];
  /** `.cmd` / `.bat` の入口のため cmd.exe を挟むか (Node の `shell: true` と同じ組み立て)。 */
  shell: boolean;
  cwd?: string;
  /** 子の環境変数一式 (継承ではなく全置換)。 */
  env: Record<string, string>;
  stdoutPath: string;
  stderrPath: string;
}

export interface HiddenConsoleSpawnOptions {
  /** テスト用: ヘルパー実行の差し替え。stdin に渡す JSON を受け取り stdout を返す。 */
  runHelper?: (input: string, timeoutMs: number) => Promise<string>;
  timeoutMs?: number;
}

/** Add-Type のコンパイルを含むため、Node の spawn より長めに取る。 */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Windows のコマンドライン 1 引数を CommandLineToArgvW の規則で引用する
 * (libuv の quote_cmd_arg と同じ結果になる)。
 */
export function quoteWindowsArgument(value: string): string {
  if (value.length === 0) return '""';
  if (!/[ \t"]/.test(value)) return value;
  if (!/["\\]/.test(value)) return `"${value}"`;
  let quoted = '"';
  let backslashes = 0;
  for (const ch of value) {
    if (ch === '\\') {
      backslashes += 1;
      continue;
    }
    if (ch === '"') quoted += '\\'.repeat(backslashes * 2 + 1) + '"';
    else quoted += '\\'.repeat(backslashes) + ch;
    backslashes = 0;
  }
  return `${quoted}${'\\'.repeat(backslashes * 2)}"`;
}

/**
 * CreateProcessW へ渡す実行ファイル名とコマンドラインを組み立てる。
 * shell 経由は Node の shell: true 起動と同じ
 * `<comspec> /d /s /c "<command> <args...>"` (引数は畳むだけで引用しない) にする。
 */
export function buildCreateProcessCommand(request: Pick<HiddenConsoleSpawnRequest, 'command' | 'args' | 'shell' | 'env'>): {
  applicationName: string | null;
  commandLine: string;
} {
  if (request.shell) {
    const comspec = lookupEnv(request.env, 'ComSpec') ?? 'cmd.exe';
    const joined = [request.command, ...request.args].join(' ');
    return {
      applicationName: isAbsolute(comspec) ? comspec : null,
      commandLine: `${quoteWindowsArgument(comspec)} /d /s /c "${joined}"`,
    };
  }
  return {
    // 絶対パスなら探索させない (CreateProcessW の探索順は Node の PATH 探索と違う)。
    applicationName: isAbsolute(request.command) ? request.command : null,
    commandLine: [request.command, ...request.args].map(quoteWindowsArgument).join(' '),
  };
}

/** ヘルパーの stdin に流す JSON。 */
export function buildHelperInput(request: HiddenConsoleSpawnRequest): string {
  const { applicationName, commandLine } = buildCreateProcessCommand(request);
  return JSON.stringify({
    applicationName,
    commandLine,
    cwd: request.cwd ?? null,
    // CreateProcessW の環境ブロック (`k=v\0...\0\0`)。順序は Windows の慣例に合わせて名前順。
    env: Object.entries(request.env)
      .sort(([a], [b]) => (a.toUpperCase() < b.toUpperCase() ? -1 : a.toUpperCase() > b.toUpperCase() ? 1 : 0))
      .map(([key, value]) => `${key}=${value}`),
    stdoutPath: request.stdoutPath,
    stderrPath: request.stderrPath,
  });
}

/** ヘルパーの出力 (最後の JSON 行) から pid を取り出す。失敗は理由付きで throw する。 */
export function parseHelperOutput(output: string): number {
  const line = output
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith('{'))
    .at(-1);
  if (!line) throw new Error(`hidden-console spawn helper returned no result: ${bound(output)}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new Error(`hidden-console spawn helper result is not valid JSON: ${bound(line)}`, { cause: error });
  }
  const record = parsed as { pid?: unknown; error?: unknown };
  if (typeof record.error === 'string') throw new Error(`spawn failed: ${bound(record.error)}`);
  if (typeof record.pid !== 'number' || !Number.isSafeInteger(record.pid) || record.pid <= 0) {
    throw new Error(`hidden-console spawn helper returned an invalid pid: ${String(record.pid)}`);
  }
  return record.pid;
}

/** 窓の無いコンソールで実プロセスを起動し、その pid を返す。失敗は throw (無言 fallback 禁止)。 */
export async function spawnWithHiddenConsole(
  request: HiddenConsoleSpawnRequest,
  options: HiddenConsoleSpawnOptions = {},
): Promise<number> {
  const run = options.runHelper ?? runHelperProcess;
  const output = await run(buildHelperInput(request), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  return parseHelperOutput(output);
}

function lookupEnv(env: Record<string, string>, name: string): string | undefined {
  const upper = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === upper) return value;
  }
  return undefined;
}

/**
 * CreateProcessW を呼ぶ C#。PowerShell 5.1 の Add-Type (C# 5) で通る書き方に留める。
 * 戻り値は子の pid。失敗は OS の理由文と Win32 エラー番号を載せた例外で投げる。
 */
const CREATE_PROCESS_SOURCE = String.raw`
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class ExcubitorHiddenConsoleSpawn
{
    const uint GENERIC_READ = 0x80000000;
    const uint FILE_APPEND_DATA = 0x4;
    const uint SYNCHRONIZE = 0x100000;
    const uint FILE_SHARE_ALL = 0x7;
    const uint OPEN_EXISTING = 3;
    const uint OPEN_ALWAYS = 4;
    const uint FILE_ATTRIBUTE_NORMAL = 0x80;
    const uint CREATE_NEW_PROCESS_GROUP = 0x200;
    const uint CREATE_UNICODE_ENVIRONMENT = 0x400;
    const uint EXTENDED_STARTUPINFO_PRESENT = 0x80000;
    const uint CREATE_NO_WINDOW = 0x08000000;
    const int STARTF_USESHOWWINDOW = 0x1;
    const int STARTF_USESTDHANDLES = 0x100;
    static readonly IntPtr PROC_THREAD_ATTRIBUTE_HANDLE_LIST = (IntPtr)0x20002;
    static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential)]
    struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public int bInheritHandle; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO
    {
        public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public int dwX; public int dwY; public int dwXSize; public int dwYSize;
        public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags;
        public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2;
        public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateFileW(string name, uint access, uint share, ref SECURITY_ATTRIBUTES sa, uint disposition, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnSize);

    [DllImport("kernel32.dll")]
    static extern void DeleteProcThreadAttributeList(IntPtr list);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);

    // Win32Exception(code, message) は OS の理由文を捨てるので、理由文と番号を自分で付ける。
    static Exception Fail(string what)
    {
        int code = Marshal.GetLastWin32Error();
        return new Exception(what + ": " + new Win32Exception(code).Message + " (Win32 error " + code + ")");
    }

    static IntPtr Open(string path, uint access, uint disposition)
    {
        SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES();
        sa.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
        sa.bInheritHandle = 1;
        IntPtr handle = CreateFileW(path, access, FILE_SHARE_ALL, ref sa, disposition, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
        if (handle == INVALID_HANDLE_VALUE) throw Fail("cannot open " + path);
        return handle;
    }

    public static int Start(string app, string commandLine, string cwd, string[] env, string stdoutPath, string stderrPath)
    {
        IntPtr stdin = IntPtr.Zero, stdout = IntPtr.Zero, stderr = IntPtr.Zero;
        IntPtr handles = IntPtr.Zero, attributes = IntPtr.Zero, block = IntPtr.Zero;
        bool attributesReady = false;
        // PowerShell は [string] 引数の $null を空文字にする。空の cwd / 実行ファイル名は
        // CreateProcessW で ERROR_INVALID_NAME になるため、「指定なし」に戻す。
        if (string.IsNullOrEmpty(app)) app = null;
        if (string.IsNullOrEmpty(cwd)) cwd = null;
        try
        {
            stdin = Open("NUL", GENERIC_READ, OPEN_EXISTING);
            stdout = Open(stdoutPath, FILE_APPEND_DATA | SYNCHRONIZE, OPEN_ALWAYS);
            stderr = Open(stderrPath, FILE_APPEND_DATA | SYNCHRONIZE, OPEN_ALWAYS);

            handles = Marshal.AllocHGlobal(IntPtr.Size * 3);
            Marshal.WriteIntPtr(handles, 0, stdin);
            Marshal.WriteIntPtr(handles, IntPtr.Size, stdout);
            Marshal.WriteIntPtr(handles, IntPtr.Size * 2, stderr);

            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            attributes = Marshal.AllocHGlobal(size);
            if (!InitializeProcThreadAttributeList(attributes, 1, 0, ref size)) throw Fail("InitializeProcThreadAttributeList");
            attributesReady = true;
            if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles, (IntPtr)(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero))
                throw Fail("UpdateProcThreadAttribute");

            StringBuilder envText = new StringBuilder();
            foreach (string entry in env) { envText.Append(entry); envText.Append('\0'); }
            envText.Append('\0');
            block = Marshal.StringToHGlobalUni(envText.ToString());

            STARTUPINFOEX si = new STARTUPINFOEX();
            si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
            si.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
            si.StartupInfo.wShowWindow = 0;
            si.StartupInfo.hStdInput = stdin;
            si.StartupInfo.hStdOutput = stdout;
            si.StartupInfo.hStdError = stderr;
            si.lpAttributeList = attributes;

            PROCESS_INFORMATION pi;
            uint flags = CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT;
            if (!CreateProcessW(app, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true, flags, block, cwd, ref si, out pi))
                throw Fail("CreateProcessW " + commandLine);
            CloseHandle(pi.hThread);
            CloseHandle(pi.hProcess);
            return pi.dwProcessId;
        }
        finally
        {
            if (attributesReady) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
            if (block != IntPtr.Zero) Marshal.FreeHGlobal(block);
            if (stdin != IntPtr.Zero && stdin != INVALID_HANDLE_VALUE) CloseHandle(stdin);
            if (stdout != IntPtr.Zero && stdout != INVALID_HANDLE_VALUE) CloseHandle(stdout);
            if (stderr != IntPtr.Zero && stderr != INVALID_HANDLE_VALUE) CloseHandle(stderr);
        }
    }
}
`;

/**
 * ヘルパーの PowerShell スクリプト。`-EncodedCommand` で渡すので複数行構文が使える
 * (`-Command -` の stdin 渡しは行継続で無言終了する。breakaway-spawn.ts 参照)。
 * spec は stdin、結果は stdout の 1 行 JSON。
 */
/**
 * コンパイル済みヘルパー (DLL) の置き場所。名前にソースのハッシュを入れ、同じソースなら使い回す。
 * Add-Type のコンパイル (csc.exe の起動) は負荷下で 15 秒を超えることがあり (2026-10-11 実測)、
 * サービス起動のたびに払うと supervisor の結果待ち (20 秒) に収まらない。
 */
export function helperAssemblyPath(): string {
  const hash = createHash('sha256').update(CREATE_PROCESS_SOURCE).digest('hex').slice(0, 12);
  return join(tmpdir(), 'excubitor', `hidden-console-spawn-${hash}.dll`);
}

export function buildHelperScript(assemblyPath: string = helperAssemblyPath()): string {
  const quotedAssembly = `'${assemblyPath.replace(/'/g, "''")}'`;
  return [
    "$ErrorActionPreference = 'Stop'",
    // 既定の [Console]::In / Out は OEM コードページ (日本語環境は cp932)。UTF-8 の env が化けて
    // JSON の解析に失敗し、理由文も化ける (2026-10-11 実測)。入出力とも UTF-8 に固定する。
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
    'try {',
    '  $reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), (New-Object System.Text.UTF8Encoding $false))',
    '  $raw = $reader.ReadToEnd()',
    // 解析失敗の例外文には入力 (= 起動 credential を含む env) が載るため、理由を固定文にする。
    '  try { $spec = $raw | ConvertFrom-Json } catch { throw (New-Object System.Exception "launch spec is not valid JSON") }',
    `  $assembly = ${quotedAssembly}`,
    '  if (-not (Test-Path -LiteralPath $assembly -PathType Leaf)) {',
    '    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $assembly) | Out-Null',
    '    $temporary = "$assembly.$PID.tmp.dll"',
    `    Add-Type -TypeDefinition @'\n${CREATE_PROCESS_SOURCE}\n'@ -OutputAssembly $temporary`,
    // 同時に別の起動がコンパイルを終えていれば、そちらの DLL を使う (rename は原子的)。
    '    try { Move-Item -LiteralPath $temporary -Destination $assembly -ErrorAction Stop } catch { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }',
    '  }',
    '  Add-Type -LiteralPath $assembly',
    '  $cwd = if ($null -eq $spec.cwd) { $null } else { [string]$spec.cwd }',
    '  $app = if ($null -eq $spec.applicationName) { $null } else { [string]$spec.applicationName }',
    '  $childPid = [ExcubitorHiddenConsoleSpawn]::Start($app, [string]$spec.commandLine, $cwd, [string[]]@($spec.env), [string]$spec.stdoutPath, [string]$spec.stderrPath)',
    '  @{ pid = $childPid } | ConvertTo-Json -Compress',
    '} catch {',
    '  @{ error = $_.Exception.Message } | ConvertTo-Json -Compress',
    '}',
  ].join('\n');
}

function runHelperProcess(input: string, timeoutMs: number): Promise<string> {
  const encoded = Buffer.from(buildHelperScript(), 'utf16le').toString('base64');
  return new Promise<string>((resolve, reject) => {
    // pipe の stdio + windowsHide でヘルパーは CREATE_NO_WINDOW (窓の無いコンソール) になる。
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
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
      finish(new Error(`hidden-console spawn helper timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', (error) => finish(new Error(`failed to start powershell.exe: ${error.message}`)));
    child.once('close', (code) => {
      const out = Buffer.concat(stdout).toString('utf8');
      if (/^\s*\{/m.test(out)) {
        finish(null, out);
        return;
      }
      const detail = Buffer.concat(stderr).toString('utf8').trim();
      finish(new Error(`hidden-console spawn helper produced no result (exit code ${String(code)}): ${bound(detail || out)}`));
    });
    child.stdin.end(input);
  });
}

function bound(value: string, limit = 400): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}
