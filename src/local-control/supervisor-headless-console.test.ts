/**
 * supervisor は Scheduled Task から窓無しランチャー (scripts/windows-hidden-launcher.cs) 経由で
 * 起動する (design.md §17.7)。node.exe を直接起動すると起動のたびにコンソールが確保され、
 * 既定ターミナル (Windows Terminal) への引き渡しで窓が出る。
 * ここではランチャーを実際にビルドし、その下の node が窓の無いコンソールを持つこと、
 * その子が新しいコンソールを作らないこと、exit code がそのまま返ることを確かめる (win32 のみ)。
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryDirs: string[] = [];
const BUILDER = fileURLToPath(new URL('../../scripts/windows-hidden-launcher.ps1', import.meta.url));

afterEach(() => {
  while (temporaryDirs.length > 0) {
    rmSync(temporaryDirs.pop()!, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

function powershell(command: string): string {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

/** pid の直下にいる conhost.exe (= そのプロセスが確保したコンソール) の数。 */
function conhostChildren(pid: number): number {
  return Number(powershell(`@(Get-CimInstance Win32_Process -Filter "Name='conhost.exe' AND ParentProcessId=${pid}").Count`));
}

function parentOf(pid: number): number {
  return Number(powershell(`(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`));
}

async function waitFor(check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe.runIf(process.platform === 'win32')('supervisor behind the windowless launcher (win32)', () => {
  it(
    'runs node in a windowless console that its children inherit and returns its exit code',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'ex-hidden-launcher-'));
      temporaryDirs.push(dir);
      const launcher = powershell(`. '${BUILDER}'; Install-ExcubitorHiddenLauncher '${dir}'`);
      expect(launcher).toMatch(/excubitor-hidden-launcher-[0-9a-f]{12}\.exe$/);
      // 同じソースなら再ビルドせず同じ exe を返す (実行中の Task が掴む exe を上書きしない)。
      expect(powershell(`. '${BUILDER}'; Install-ExcubitorHiddenLauncher '${dir}'`)).toBe(launcher);

      const marker = join(dir, 'marker.json');
      const release = join(dir, 'release');
      const script = join(dir, 'supervisor.cjs');
      writeFileSync(
        script,
        [
          "const { spawn } = require('node:child_process');",
          "const { existsSync, writeFileSync } = require('node:fs');",
          // windowsHide を付けない console app の起動。
          "const grandchild = spawn('cmd.exe', ['/d', '/c', 'ping -n 30 127.0.0.1 >nul'], { stdio: 'ignore' });",
          `writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, grandchild: grandchild.pid, args: process.argv.slice(2) }));`,
          `const timer = setInterval(() => { if (existsSync(${JSON.stringify(release)})) { grandchild.kill(); clearInterval(timer); process.exit(7); } }, 50);`,
        ].join('\n'),
        'utf8',
      );

      // Task Scheduler と同じく、フラグ無し・std ハンドル無しで起動する。
      const host = spawn(launcher, [process.execPath, script, '--service-name=Excubitor Test'], { stdio: 'ignore' });
      const exited = new Promise<number | null>((resolve) => host.once('exit', (code) => resolve(code)));

      try {
        await waitFor(() => existsSync(marker));
        const { pid, grandchild, args } = JSON.parse(readFileSync(marker, 'utf8')) as {
          pid: number;
          grandchild: number;
          args: string[];
        };
        expect(args).toEqual(['--service-name=Excubitor Test']);
        expect(parentOf(pid)).toBe(host.pid);
        // node は自前の窓無しコンソールを 1 つ持ち、孫はそれを継承して新しく作らない。
        expect(conhostChildren(pid)).toBe(1);
        expect(conhostChildren(grandchild)).toBe(0);

        writeFileSync(release, '', 'utf8');
        expect(await exited).toBe(7);
      } finally {
        if (host.exitCode === null) {
          try {
            execFileSync('taskkill', ['/PID', String(host.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
          } catch {
            // 既に終わっていれば何もしない。
          }
        }
      }
    },
    90_000,
  );
});
