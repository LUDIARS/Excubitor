/**
 * Reap a spawned child process **and its descendants** on Windows.
 *
 * `ChildProcess.kill('SIGTERM')` on Windows only signals the immediate child.
 * For probes that shell out to `wsl.exe` / `docker` (Rancher), the immediate
 * child is a thin launcher that has already spawned a `wsl-helper` /
 * `OpenConsole` backend on the WSL side. Killing only the launcher orphans that
 * backend, which keeps its handles/pseudo-console alive. When such a probe
 * times out every scan tick (e.g. Rancher is unhealthy), the orphaned backends
 * accumulate — leaking handles/consoles until the machine exhausts nonpaged
 * pool (WSAENOBUFS). Reaping the whole tree with `taskkill /T` prevents the
 * leak at its source (root cause of the recurring "infinite console" storms).
 */

import { spawn, type ChildProcess } from 'node:child_process';

const TASKKILL_REAPER_TIMEOUT_MS = 10_000;

/**
 * Kill `child` and every descendant. Best-effort and non-throwing: a probe's
 * timeout path must never crash the scanner/memory loop.
 */
export function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid == null) return;
  if (process.platform === 'win32') {
    try {
      // /T = whole tree (reaps the orphaned wsl-helper / OpenConsole backend),
      // /F = force. Detached + ignored stdio so the reaper itself never leaks a
      // console or blocks. Its own failure is irrelevant to the caller.
      const reaper = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
        detached: true,
      });
      // taskkill 自体が WMI/OS 側で固まることがある。detached のまま無期限に残さない。
      const timeout = setTimeout(() => {
        try { reaper.kill('SIGKILL'); } catch { /* already gone */ }
      }, TASKKILL_REAPER_TIMEOUT_MS);
      timeout.unref?.();
      const clearReaperTimeout = (): void => clearTimeout(timeout);
      reaper.once('close', clearReaperTimeout);
      reaper.once('error', clearReaperTimeout);
      reaper.unref();
    } catch {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
    return;
  }
  try { child.kill('SIGTERM'); } catch { /* already gone */ }
}
