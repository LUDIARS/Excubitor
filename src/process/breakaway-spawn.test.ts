import { describe, expect, it, vi } from 'vitest';
import {
  buildCreateScript,
  buildRedirectedCommandLine,
  parseCreateOutput,
  quoteWindowsArgument,
  spawnOutsideJob,
} from './breakaway-spawn.js';

describe('quoteWindowsArgument', () => {
  it('quotes values that cmd.exe would otherwise split or interpret', () => {
    expect(quoteWindowsArgument('E:\\Program Files\\hora\\hora.exe')).toBe(
      '"E:\\Program Files\\hora\\hora.exe"',
    );
    expect(quoteWindowsArgument('a&b')).toBe('"a&b"');
    expect(quoteWindowsArgument('')).toBe('""');
  });

  it('leaves plain tokens untouched', () => {
    expect(quoteWindowsArgument('--headless')).toBe('--headless');
  });

  it('rejects an embedded double quote instead of producing an ambiguous line', () => {
    expect(() => quoteWindowsArgument('a"b')).toThrow(/double quote/);
  });

  it("rejects '%' because cmd.exe expands it even inside quotes", () => {
    // child 戦略 (shell:false) では素通りしていた値。引用では防げないので、
    // 静かに書き換わるより fail-fast する。
    expect(() => quoteWindowsArgument('E:\\build\\100%\\app.exe')).toThrow(/'%'/);
  });
});

describe('buildRedirectedCommandLine', () => {
  it('wraps the command in cmd.exe with append redirection', () => {
    const line = buildRedirectedCommandLine(
      'npm run start',
      'E:\\logs\\svc.out.log',
      'E:\\logs\\svc.err.log',
    );
    expect(line).toBe(
      'cmd.exe /d /s /c "npm run start 1>>"E:\\logs\\svc.out.log" 2>>"E:\\logs\\svc.err.log""',
    );
  });

  it('rejects an empty command line', () => {
    expect(() => buildRedirectedCommandLine('  ', 'out', 'err')).toThrow(/non-empty command/);
  });

  it('rejects a log path containing a double quote (redirect escape)', () => {
    expect(() => buildRedirectedCommandLine('app.exe', 'a".log', 'err')).toThrow(/double quote/);
    expect(() => buildRedirectedCommandLine('app.exe', 'out', 'e".log')).toThrow(/double quote/);
  });
});

describe('buildCreateScript', () => {
  it('embeds the spec as base64 so secrets never reach a command line', () => {
    const script = buildCreateScript({
      commandLine: 'node server.js',
      cwd: 'E:\\svc',
      env: { SECRET_TOKEN: 'hunter2', PATH: 'C:\\bin' },
      stdoutPath: 'out.log',
      stderrPath: 'err.log',
    });
    expect(script).not.toContain('hunter2');
    expect(script).toContain('FromBase64String');
    expect(script).toContain('Win32_ProcessStartup');
    expect(script).toContain('Invoke-CimMethod');
    // base64 を復号すると env が K=V 形式で入っている。
    const encoded = /FromBase64String\('([^']+)'\)/.exec(script)?.[1];
    expect(encoded).toBeDefined();
    const payload = JSON.parse(Buffer.from(encoded!, 'base64').toString('utf8')) as {
      commandLine: string;
      cwd: string | null;
      env: string[];
    };
    expect(payload.env).toContain('SECRET_TOKEN=hunter2');
    expect(payload.cwd).toBe('E:\\svc');
    expect(payload.commandLine).toContain('node server.js');
  });

  it('never leaves a line open for continuation (stdin -Command - silently no-ops on it)', () => {
    // 実測 (2026-08-03): Windows PowerShell 5.1 へ `-Command -` (stdin) で複数行の
    // `@{` 継続や try/catch を渡すと、例外もエラーも出さず exit code 0 / 出力ゼロで
    // 終わる。行ごとに完結したステートメントであることをここで機械的に保証する。
    // `{` だけでなく、再フォーマットで入り込みやすい他の継続トークンも同時に禁じる。
    const CONTINUATION_SUFFIXES = ['{', '(', '|', ',', '=', '`'];
    const script = buildCreateScript({
      commandLine: 'node server.js',
      env: { A: '1' },
      stdoutPath: 'out.log',
      stderrPath: 'err.log',
    });
    for (const line of script.split('\n')) {
      const trimmed = line.trim();
      const dangling = CONTINUATION_SUFFIXES.find((suffix) => trimmed.endsWith(suffix));
      expect(dangling, `line continues past its end with '${dangling}': ${trimmed}`).toBeUndefined();
    }
  });

  it('omits CurrentDirectory when cwd is not given', () => {
    const script = buildCreateScript({
      commandLine: 'app.exe',
      env: {},
      stdoutPath: 'out.log',
      stderrPath: 'err.log',
    });
    const encoded = /FromBase64String\('([^']+)'\)/.exec(script)![1]!;
    const payload = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as { cwd: null };
    expect(payload.cwd).toBeNull();
  });
});

describe('parseCreateOutput', () => {
  it('accepts a successful create result', () => {
    expect(parseCreateOutput('{"ReturnValue":0,"ProcessId":1234}\r\n')).toEqual({ pid: 1234 });
  });

  it('takes the last JSON line when preamble noise is present', () => {
    const output = 'WARNING: something\n{"ReturnValue":0,"ProcessId":77}\n';
    expect(parseCreateOutput(output)).toEqual({ pid: 77 });
  });

  it('maps non-zero return values to readable failures', () => {
    expect(() => parseCreateOutput('{"ReturnValue":9,"ProcessId":null}')).toThrow(
      /ReturnValue=9 \(path not found\)/,
    );
  });

  it('rejects a missing or invalid pid', () => {
    expect(() => parseCreateOutput('{"ReturnValue":0}')).toThrow(/invalid ProcessId/);
    expect(() => parseCreateOutput('no json at all')).toThrow(/no JSON result/);
  });

  it('redacts the base64 spec if PowerShell echoes the failing line back', () => {
    // PowerShell はエラー時に落ちた行 (= base64 の spec = credential) を stderr に
    // 書く。診断へ素通しすると可逆な形でログに残るため落とす。
    const encoded = Buffer.from(
      JSON.stringify({ env: ['TOKEN=hunter2', 'CERNERE_LAUNCH_CREDENTIAL=abcdefghijklmnop'] }),
      'utf8',
    ).toString('base64');
    expect(encoded.length).toBeGreaterThan(64);
    let message = '';
    try {
      parseCreateOutput(`At line:1 char:1 FromBase64String('${encoded}')`);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/no JSON result/);
    expect(message).toContain('[redacted]');
    expect(message).not.toContain(encoded);
  });
});

describe('spawnOutsideJob', () => {
  it('runs the create script through the injected PowerShell runner', async () => {
    const runPowerShell = vi.fn(async (script: string) => {
      expect(script).toContain('Invoke-CimMethod');
      return '{"ReturnValue":0,"ProcessId":555}';
    });
    const result = await spawnOutsideJob(
      {
        commandLine: 'node x.js',
        env: { A: '1' },
        stdoutPath: 'o.log',
        stderrPath: 'e.log',
      },
      { runPowerShell },
    );
    expect(result).toEqual({ pid: 555 });
  });

  it('propagates create failures without a silent fallback', async () => {
    const runPowerShell = vi.fn(async () => '{"ReturnValue":2,"ProcessId":null}');
    await expect(
      spawnOutsideJob(
        { commandLine: 'node x.js', env: {}, stdoutPath: 'o', stderrPath: 'e' },
        { runPowerShell },
      ),
    ).rejects.toThrow(/access denied/);
  });
});
