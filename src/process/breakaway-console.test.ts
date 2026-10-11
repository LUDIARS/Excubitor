/**
 * WMI → launcher → 実プロセスの通し起動で、窓を出すコンソールが 1 つもできないことを確かめる
 * (win32 専用、design.md §17.7)。単体の組み立ては breakaway-spawn.test.ts / hidden-console-spawn.test.ts。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { buildLauncherCommandLine, resolveLauncherPath, spawnOutsideJob } from './breakaway-spawn.js';

const temporaryDirs: string[] = [];

afterEach(() => {
  while (temporaryDirs.length > 0) {
    // taskkill 直後は孫がまだフォルダを掴んでいることがある。
    rmSync(temporaryDirs.pop()!, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
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

async function waitFor(check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe.runIf(process.platform === 'win32')('job-breakaway start without console windows (win32)', () => {
  it(
    'starts the service with its own windowless console that its children inherit',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'ex-breakaway-console-'));
      temporaryDirs.push(dir);
      const script = join(dir, 'service.cjs');
      const release = join(dir, 'release');
      writeFileSync(
        script,
        [
          "const { spawn } = require('node:child_process');",
          "const { existsSync } = require('node:fs');",
          // windowsHide を付けない console app の起動 (サービス側でよくある形)。
          "const grandchild = spawn('cmd.exe', ['/d', '/c', 'ping -n 60 127.0.0.1 >nul'], { stdio: 'ignore' });",
          "process.stdout.write('grandchild=' + grandchild.pid + '\\n');",
          // 照会が終わるまで生かしておく (負荷下では照会に数秒かかる)。合図で孫を止めてから終わる。
          `const timer = setInterval(() => { if (existsSync(${JSON.stringify(release)})) { grandchild.kill(); clearInterval(timer); process.exit(0); } }, 50);`,
        ].join('\n'),
        'utf8',
      );
      const stdoutPath = join(dir, 'svc.out.log');
      // vitest 下の launcher は .ts なので、tsx の loader を付けて WMI から起動する。
      const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href;

      const { pid } = await spawnOutsideJob(
        {
          command: process.execPath,
          args: [script],
          shell: false,
          // 消す一時フォルダを cwd にしない (終了直後のプロセスが掴んで片付けが EPERM になる)。
          cwd: tmpdir(),
          env: { ...process.env } as Record<string, string>,
          stdoutPath,
          stderrPath: join(dir, 'svc.err.log'),
        },
        {
          launcherCommandLine: buildLauncherCommandLine(process.execPath, ['--import', tsxLoader], resolveLauncherPath()),
          timeoutMs: 30_000,
          resultTimeoutMs: 30_000,
        },
      );

      let grandchild: number | undefined;
      try {
        await waitFor(() => /grandchild=(\d+)/.test(readFileSync(stdoutPath, 'utf8')));
        grandchild = Number(/grandchild=(\d+)/.exec(readFileSync(stdoutPath, 'utf8'))![1]);
        expect(conhostChildren(pid)).toBe(1);
        expect(conhostChildren(grandchild)).toBe(0);
      } finally {
        writeFileSync(release, '', 'utf8');
        // 親が先に終わっていると孫はツリーから外れるので、孫も直接止める。
        for (const target of [pid, grandchild]) {
          if (target === undefined) continue;
          try {
            execFileSync('taskkill', ['/PID', String(target), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
          } catch {
            // 既に終わっていれば何もしない。
          }
        }
      }
    },
    60_000,
  );
});
