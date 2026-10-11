import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildCreateProcessCommand,
  buildHelperInput,
  buildHelperScript,
  helperAssemblyPath,
  parseHelperOutput,
  quoteWindowsArgument,
  spawnWithHiddenConsole,
} from './hidden-console-spawn.js';

const temporaryDirs: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ex-hidden-console-'));
  temporaryDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (temporaryDirs.length > 0) {
    // taskkill 直後は孫がまだフォルダを掴んでいることがある。
    rmSync(temporaryDirs.pop()!, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

describe('quoteWindowsArgument', () => {
  it.each([
    ['plain', 'plain'],
    ['', '""'],
    ['has space', '"has space"'],
    ['C:\\Program Files\\nodejs\\node.exe', '"C:\\Program Files\\nodejs\\node.exe"'],
    ['say "hi"', '"say \\"hi\\""'],
    ['trailing\\ dir\\', '"trailing\\ dir\\\\"'],
    ['a\\"b c', '"a\\\\\\"b c"'],
    ['C:\\no-space\\path', 'C:\\no-space\\path'],
  ])('quotes %j as %j', (input, expected) => {
    expect(quoteWindowsArgument(input)).toBe(expected);
  });
});

describe('buildCreateProcessCommand', () => {
  it('runs an absolute executable directly without searching', () => {
    expect(
      buildCreateProcessCommand({
        command: 'C:\\Program Files\\nodejs\\node.exe',
        args: ['dist/server.js', '--name=a b'],
        shell: false,
        env: {},
      }),
    ).toEqual({
      applicationName: 'C:\\Program Files\\nodejs\\node.exe',
      commandLine: '"C:\\Program Files\\nodejs\\node.exe" dist/server.js "--name=a b"',
    });
  });

  it('wraps .cmd / .bat entries in cmd.exe the same way Node shell spawn does', () => {
    expect(
      buildCreateProcessCommand({
        command: 'start-memoria.bat',
        args: ['--dev'],
        shell: true,
        env: { COMSPEC: 'C:\\WINDOWS\\system32\\cmd.exe' },
      }),
    ).toEqual({
      applicationName: 'C:\\WINDOWS\\system32\\cmd.exe',
      commandLine: 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c "start-memoria.bat --dev"',
    });
  });

  it('falls back to cmd.exe on PATH when ComSpec is missing', () => {
    const built = buildCreateProcessCommand({ command: 'x.cmd', args: [], shell: true, env: {} });
    expect(built).toEqual({ applicationName: null, commandLine: 'cmd.exe /d /s /c "x.cmd"' });
  });
});

describe('buildHelperInput', () => {
  it('passes the environment as a sorted block and keeps it off the command line', () => {
    const input = JSON.parse(
      buildHelperInput({
        command: 'C:\\node.exe',
        args: ['a.js'],
        shell: false,
        env: { b: '2', A: '1', SECRET_TOKEN: 'hunter2' },
        stdoutPath: 'E:\\logs\\svc.out.log',
        stderrPath: 'E:\\logs\\svc.err.log',
      }),
    ) as { env: string[]; commandLine: string; cwd: unknown };
    expect(input.env).toEqual(['A=1', 'b=2', 'SECRET_TOKEN=hunter2']);
    expect(input.commandLine).not.toContain('hunter2');
    expect(input.cwd).toBeNull();
  });
});

describe('buildHelperScript', () => {
  it('compiles the helper once and loads the cached assembly afterwards', () => {
    // 起動のたびの Add-Type コンパイルは負荷下で 15 秒を超え、supervisor の結果待ちに収まらない。
    expect(helperAssemblyPath()).toMatch(/hidden-console-spawn-[0-9a-f]{12}\.dll$/);
    const script = buildHelperScript("C:\\Temp\\it's\\helper.dll");
    expect(script).toContain("$assembly = 'C:\\Temp\\it''s\\helper.dll'");
    expect(script).toContain('if (-not (Test-Path -LiteralPath $assembly -PathType Leaf))');
    expect(script).toContain('-OutputAssembly $temporary');
    expect(script).toContain('Add-Type -LiteralPath $assembly');
  });
});

describe('parseHelperOutput', () => {
  it('reads the pid from the last JSON line', () => {
    expect(parseHelperOutput('noise\r\n{"pid":4321}\r\n')).toBe(4321);
  });

  it('surfaces the Win32 reason instead of an empty failure', () => {
    expect(() => parseHelperOutput('{"error":"The system cannot find the file specified"}')).toThrow(
      /spawn failed: The system cannot find the file specified/,
    );
  });

  it('rejects output without a result', () => {
    expect(() => parseHelperOutput('')).toThrow(/no result/);
    expect(() => parseHelperOutput('{"pid":0}')).toThrow(/invalid pid/);
  });
});

/** pid の直下にいる conhost.exe (= そのプロセスが確保したコンソール) の数。 */
function conhostChildren(pid: number): number {
  const out = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `@(Get-CimInstance Win32_Process -Filter "Name='conhost.exe' AND ParentProcessId=${pid}").Count`,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  return Number(out.trim());
}

/** 孫 (cmd.exe) が一時フォルダを掴んだまま残らないよう、ツリーごと止める。 */
function killTreeQuietly(pid: number): void {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch {
    // 既に終わっていれば何もしない。
  }
}

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe.runIf(process.platform === 'win32')('spawnWithHiddenConsole (win32)', () => {
  it(
    'gives the service a windowless console that its children inherit',
    async () => {
      // 回帰の本体 (2026-10-11): DETACHED_PROCESS で起動されたサービスが console app を
      // windowsHide 無しで起動するたびに、新しいコンソール (= 窓) ができていた。
      const dir = workspace();
      const script = join(dir, 'child.cjs');
      const release = join(dir, 'release');
      writeFileSync(
        script,
        [
          "const { spawn } = require('node:child_process');",
          "const { existsSync } = require('node:fs');",
          "process.stdout.write('argv=' + JSON.stringify(process.argv.slice(2)) + ' foo=' + process.env.FOO + '\\n');",
          "process.stderr.write('to-stderr\\n');",
          // windowsHide を付けない console app の起動 (サービス側でよくある形)。
          "const grandchild = spawn('cmd.exe', ['/d', '/c', 'ping -n 60 127.0.0.1 >nul'], { stdio: 'ignore' });",
          "process.stdout.write('grandchild=' + grandchild.pid + '\\n');",
          // 照会が終わるまで生かしておく (負荷下では照会に数秒かかる)。合図で孫を止めてから終わる。
          `const timer = setInterval(() => { if (existsSync(${JSON.stringify(release)})) { grandchild.kill(); clearInterval(timer); process.exit(0); } }, 50);`,
        ].join('\n'),
        'utf8',
      );
      const stdoutPath = join(dir, 'svc.out.log');
      const stderrPath = join(dir, 'svc.err.log');
      writeFileSync(stdoutPath, 'existing\n', 'utf8');

      const pid = await spawnWithHiddenConsole({
        command: process.execPath,
        args: [script, 'a b', 'q"x', 'tail\\'],
        shell: false,
        // 消す一時フォルダを cwd にしない (終了直後のプロセスが掴んで片付けが EPERM になる)。
        cwd: tmpdir(),
        env: { ...process.env, FOO: 'bar baz' } as Record<string, string>,
        stdoutPath,
        stderrPath,
      });

      let grandchild: number | undefined;
      try {
        await waitFor(() => /grandchild=(\d+)/.test(readFileSync(stdoutPath, 'utf8')));
        const out = readFileSync(stdoutPath, 'utf8');
        expect(out.startsWith('existing\n')).toBe(true);
        expect(out).toContain('argv=["a b","q\\"x","tail\\\\"] foo=bar baz');
        await waitFor(() => readFileSync(stderrPath, 'utf8').includes('to-stderr'));
        grandchild = Number(/grandchild=(\d+)/.exec(out)![1]);

        // サービスは自前の (窓の無い) コンソールを 1 つ持ち、孫はそれを継承して新しく作らない。
        expect(conhostChildren(pid)).toBe(1);
        expect(conhostChildren(grandchild)).toBe(0);
      } finally {
        writeFileSync(release, '', 'utf8');
        killTreeQuietly(pid);
        // 親が先に終わっていると孫はツリーから外れるので、直接止める。
        if (grandchild !== undefined) killTreeQuietly(grandchild);
      }
    },
    30_000,
  );

  it(
    'runs .bat entries through cmd.exe with the logs attached',
    async () => {
      const dir = workspace();
      const bat = join(dir, 'start-svc.bat');
      writeFileSync(bat, '@echo off\r\necho from-bat %1\r\n', 'utf8');
      const stdoutPath = join(dir, 'svc.out.log');

      const pid = await spawnWithHiddenConsole({
        command: bat,
        args: ['first'],
        shell: true,
        // 消す一時フォルダを cwd にしない (終了直後のプロセスが掴んで片付けが EPERM になる)。
        cwd: tmpdir(),
        env: { ...process.env } as Record<string, string>,
        stdoutPath,
        stderrPath: join(dir, 'svc.err.log'),
      });

      try {
        expect(pid).toBeGreaterThan(0);
        await waitFor(() => readFileSync(stdoutPath, 'utf8').includes('from-bat first'));
      } finally {
        // 負荷下では cmd.exe が一時フォルダ (cwd) を掴んだまま残り、片付けが EPERM で落ちる (Revisor #2668)。
        killTreeQuietly(pid);
      }
    },
    30_000,
  );

  it(
    'starts a PATH command without a cwd (both left to CreateProcessW)',
    async () => {
      const dir = workspace();
      const stdoutPath = join(dir, 'svc.out.log');

      const pid = await spawnWithHiddenConsole({
        command: 'cmd.exe',
        args: ['/d', '/c', 'echo no-cwd'],
        shell: false,
        env: { ...process.env } as Record<string, string>,
        stdoutPath,
        stderrPath: join(dir, 'svc.err.log'),
      });

      try {
        expect(pid).toBeGreaterThan(0);
        await waitFor(() => readFileSync(stdoutPath, 'utf8').includes('no-cwd'));
      } finally {
        killTreeQuietly(pid);
      }
    },
    30_000,
  );

  it(
    'reports why the process could not start',
    async () => {
      const dir = workspace();
      await expect(
        spawnWithHiddenConsole({
          command: join(dir, 'does-not-exist.exe'),
          args: [],
          shell: false,
          env: { ...process.env } as Record<string, string>,
          stdoutPath: join(dir, 'svc.out.log'),
          stderrPath: join(dir, 'svc.err.log'),
        }),
      ).rejects.toThrow(/spawn failed: .*CreateProcessW/);
    },
    30_000,
  );
});
