import { spawn } from 'node:child_process';
import { killProcessTree } from '../shared/kill-tree.js';
import { containedFile } from './manifest.js';

/** @implements SPEC-SERVICE-BOOTSTRAP */
export async function runBootstrapHook(root: string, script: string, args: string[]): Promise<void> {
  const path = await containedFile(root, script);
  await new Promise<void>((resolve, reject) => {
    // Discard potentially secret output rather than accumulating it in backend memory or operation history.
    const child = spawn(process.execPath, [path, ...args], {
      cwd: root, shell: false, windowsHide: true, stdio: 'ignore', detached: process.platform !== 'win32',
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') killProcessTree(child);
      else if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
          // ESRCH means the group exited between timeout and kill. Other failures still reap the owned child.
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill('SIGKILL');
        }
      }
    }, 900_000);
    child.once('error', () => {
      clearTimeout(timer);
      reject(new Error('Cannot start service-owned script: ' + script));
    });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0 && !timedOut) resolve();
      else reject(new Error('Service-owned script failed: ' + script + (timedOut ? ' (timeout)' : ' (exit ' + String(code) + ')')));
    });
  });
}
