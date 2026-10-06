/** @implements SPEC-EX-DAILY-SITE-DEPLOY */
import { spawn } from 'node:child_process';
import { spawnEnvFor } from '../../shared/exec.js';
import { killProcessTree } from '../../shared/kill-tree.js';

/** Never begin rollback while a timed-out installer/build may still be writing. */
export function dailyCommand(command: string, args: string[], cwd: string, timeoutMs = 60_000, shell = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell, windowsHide: true, env: spawnEnvFor(command),
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') killProcessTree(child);
      else if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch { /* close/error determines completion; never release the lease on kill failure */ }
      }
    }, timeoutMs);
    const capture = (chunk: Buffer): void => { output = (output + chunk.toString('utf8')).slice(-16_384); };
    child.stdout.on('data', capture);
    // Diagnostics can contain credentials echoed by package scripts. Persist only the command category.
    child.stderr.on('data', () => undefined);
    child.once('error', () => { clearTimeout(timer); reject(new Error(`${command}: could not start`)); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || timedOut) reject(new Error(`${command}: ${timedOut ? 'timed out' : `exit ${code}`}`));
      else resolve(output.trim());
    });
  });
}
