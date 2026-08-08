import { describe, expect, it, vi } from 'vitest';
import {
  buildCreateScript,
  buildLauncherCommandLine,
  parseCreateOutput,
  parseLaunchResult,
  quoteCommandLineToken,
  resolveLauncherPath,
  selectLauncherExecArgv,
  spawnOutsideJob,
  type BreakawaySpawnSpec,
} from './breakaway-spawn.js';
import { BREAKAWAY_SPEC_ENV, type BreakawayLaunchSpec } from './breakaway-launcher.js';

const SPEC: BreakawaySpawnSpec = {
  command: 'npm',
  args: ['run', 'dev'],
  shell: true,
  cwd: 'E:\\svc',
  env: { A: '1' },
  stdoutPath: 'E:\\logs\\svc.out.log',
  stderrPath: 'E:\\logs\\svc.err.log',
};

/** buildCreateScript が埋め込んだ payload を取り出す。 */
function decodePayload(script: string): { commandLine: string; cwd: string | null; env: string[] } {
  const encoded = /FromBase64String\('([^']+)'\)/.exec(script)?.[1];
  expect(encoded).toBeDefined();
  return JSON.parse(Buffer.from(encoded!, 'base64').toString('utf8')) as {
    commandLine: string;
    cwd: string | null;
    env: string[];
  };
}

/** payload の env から launcher spec を取り出す。 */
function decodeLaunchSpec(script: string): BreakawayLaunchSpec {
  const entry = decodePayload(script).env.find((line) => line.startsWith(`${BREAKAWAY_SPEC_ENV}=`));
  expect(entry).toBeDefined();
  const encoded = entry!.slice(BREAKAWAY_SPEC_ENV.length + 1);
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as BreakawayLaunchSpec;
}

describe('quoteCommandLineToken', () => {
  it('quotes paths containing spaces', () => {
    expect(quoteCommandLineToken('C:\\Program Files\\nodejs\\node.exe')).toBe(
      '"C:\\Program Files\\nodejs\\node.exe"',
    );
    expect(quoteCommandLineToken('')).toBe('""');
  });

  it('leaves plain tokens untouched', () => {
    // cmd.exe を経由しないため `%` や `&` の展開は起きない。引用は空白だけで足りる。
    expect(quoteCommandLineToken('E:\\build\\100%\\launcher.js')).toBe('E:\\build\\100%\\launcher.js');
    expect(quoteCommandLineToken('--import')).toBe('--import');
  });

  it('rejects an embedded double quote instead of producing an ambiguous line', () => {
    expect(() => quoteCommandLineToken('a"b')).toThrow(/double quote/);
  });
});

describe('buildLauncherCommandLine', () => {
  it('carries the supervisor loader flags so dev (tsx) and dist behave the same', () => {
    expect(
      buildLauncherCommandLine(
        'C:\\Program Files\\nodejs\\node.exe',
        ['--import', 'file:///E:/x/tsx/loader.mjs'],
        'E:\\Excubitor\\dist\\process\\breakaway-launcher-main.js',
      ),
    ).toBe(
      '"C:\\Program Files\\nodejs\\node.exe" --import file:///E:/x/tsx/loader.mjs'
        + ' E:\\Excubitor\\dist\\process\\breakaway-launcher-main.js',
    );
  });
});

describe('selectLauncherExecArgv', () => {
  it('keeps source loaders without inheriting flags that change launcher lifecycle', () => {
    expect(
      selectLauncherExecArgv([
        '--inspect-brk=0',
        '--require',
        'C:\\tsx\\preflight.cjs',
        '--watch',
        '--import=file:///E:/tsx/loader.mjs',
        '--test',
      ]),
    ).toEqual([
      '--require',
      'C:\\tsx\\preflight.cjs',
      '--import=file:///E:/tsx/loader.mjs',
    ]);
  });
});

describe('resolveLauncherPath', () => {
  it('points at the launcher entrypoint next to this module', () => {
    const path = resolveLauncherPath();
    expect(path).toMatch(/breakaway-launcher-main\.(ts|js)$/);
  });
});

describe('buildCreateScript', () => {
  it('embeds the spec as base64 so secrets never reach a command line', () => {
    const script = buildCreateScript({
      commandLine: 'node launcher.js',
      cwd: 'E:\\svc',
      env: { SECRET_TOKEN: 'hunter2', PATH: 'C:\\bin' },
    });
    expect(script).not.toContain('hunter2');
    expect(script).toContain('FromBase64String');
    expect(script).toContain('Win32_ProcessStartup');
    expect(script).toContain('Invoke-CimMethod');
    const payload = decodePayload(script);
    expect(payload.env).toContain('SECRET_TOKEN=hunter2');
    expect(payload.cwd).toBe('E:\\svc');
    expect(payload.commandLine).toBe('node launcher.js');
  });

  it('never leaves a line open for continuation (stdin -Command - silently no-ops on it)', () => {
    // 実測 (2026-08-03): Windows PowerShell 5.1 へ `-Command -` (stdin) で複数行の
    // `@{` 継続や try/catch を渡すと、例外もエラーも出さず exit code 0 / 出力ゼロで
    // 終わる。行ごとに完結したステートメントであることをここで機械的に保証する。
    // `{` だけでなく、再フォーマットで入り込みやすい他の継続トークンも同時に禁じる。
    const CONTINUATION_SUFFIXES = ['{', '(', '|', ',', '=', '`'];
    const script = buildCreateScript({ commandLine: 'node launcher.js', env: { A: '1' } });
    for (const line of script.split('\n')) {
      const trimmed = line.trim();
      const dangling = CONTINUATION_SUFFIXES.find((suffix) => trimmed.endsWith(suffix));
      expect(dangling, `line continues past its end with '${dangling}': ${trimmed}`).toBeUndefined();
    }
  });

  it('omits CurrentDirectory when cwd is not given', () => {
    const script = buildCreateScript({ commandLine: 'app.exe', env: {} });
    expect(decodePayload(script).cwd).toBeNull();
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

describe('parseLaunchResult', () => {
  it('reads the real service pid', () => {
    expect(parseLaunchResult('{"pid":4321}')).toEqual({ pid: 4321 });
  });

  it('surfaces the launcher error instead of an anonymous "it exited immediately"', () => {
    expect(() => parseLaunchResult('{"error":"spawn npm ENOENT"}')).toThrow(/spawn npm ENOENT/);
  });

  it('rejects a malformed result', () => {
    expect(() => parseLaunchResult('{"pid":0}')).toThrow(/invalid pid/);
    expect(() => parseLaunchResult('null')).toThrow(/must be a JSON object/);
    expect(() => parseLaunchResult('not json')).toThrow(/not valid JSON/);
  });
});

describe('spawnOutsideJob', () => {
  function runner(processId: number) {
    return vi.fn(async (script: string) => {
      expect(script).toContain('Invoke-CimMethod');
      return `{"ReturnValue":0,"ProcessId":${processId}}`;
    });
  }

  it('returns the pid the launcher reports, not the launcher pid', async () => {
    const runPowerShell = runner(555);
    const result = await spawnOutsideJob(SPEC, {
      runPowerShell,
      resultPath: 'E:\\logs\\.breakaway-test.json',
      readResult: async () => '{"pid":4321}',
      removeResult: async () => undefined,
    });

    expect(result).toEqual({ pid: 4321 });
  });

  it('passes the argv and log paths to the launcher through env, never the command line', async () => {
    const runPowerShell = runner(555);
    await spawnOutsideJob(
      {
        ...SPEC,
        env: { ...SPEC.env, excubitor_breakaway_spec: 'shadowed-control-value' },
      },
      {
        runPowerShell,
        resultPath: 'E:\\logs\\.breakaway-test.json',
        readResult: async () => '{"pid":4321}',
        removeResult: async () => undefined,
      },
    );

    const script = runPowerShell.mock.calls[0]![0];
    const payload = decodePayload(script);
    // 常駐する cmd.exe を作らないため、コマンドラインは launcher の起動だけ。
    expect(payload.commandLine).not.toContain('npm');
    expect(payload.commandLine).not.toContain('>>');
    expect(payload.commandLine).toContain('breakaway-launcher-main');

    const launchSpec = decodeLaunchSpec(script);
    expect(launchSpec).toMatchObject({
      command: 'npm',
      args: ['run', 'dev'],
      shell: true,
      cwd: 'E:\\svc',
      stdoutPath: 'E:\\logs\\svc.out.log',
      stderrPath: 'E:\\logs\\svc.err.log',
      resultPath: 'E:\\logs\\.breakaway-test.json',
    });
    expect(
      payload.env.filter(
        (entry) => entry.slice(0, entry.indexOf('=')).toUpperCase() === BREAKAWAY_SPEC_ENV,
      ),
    ).toHaveLength(1);
  });

  it('waits for the launcher result and cleans the file up afterwards', async () => {
    const removeResult = vi.fn(async () => undefined);
    const readResult = vi
      .fn<(path: string) => Promise<string | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue('{"pid":99}');

    const result = await spawnOutsideJob(SPEC, {
      runPowerShell: runner(555),
      resultPath: 'E:\\logs\\.breakaway-test.json',
      readResult,
      removeResult,
      sleep: async () => undefined,
    });

    expect(result).toEqual({ pid: 99 });
    expect(readResult).toHaveBeenCalledTimes(3);
    expect(removeResult).toHaveBeenCalledWith('E:\\logs\\.breakaway-test.json');
  });

  it('fails closed (and still cleans up) when the launcher never reports', async () => {
    const removeResult = vi.fn(async () => undefined);

    await expect(
      spawnOutsideJob(SPEC, {
        runPowerShell: runner(555),
        resultPath: 'E:\\logs\\.breakaway-test.json',
        readResult: async () => null,
        removeResult,
        sleep: async () => undefined,
        resultTimeoutMs: 0,
      }),
    ).rejects.toThrow(/launcher \(pid=555\) did not report a pid/);
    expect(removeResult).toHaveBeenCalled();
  });

  it('propagates create failures without a silent fallback', async () => {
    const runPowerShell = vi.fn(async () => '{"ReturnValue":2,"ProcessId":null}');
    await expect(
      spawnOutsideJob(SPEC, {
        runPowerShell,
        resultPath: 'E:\\logs\\.breakaway-test.json',
        readResult: async () => null,
        removeResult: async () => undefined,
      }),
    ).rejects.toThrow(/access denied/);
  });
});
