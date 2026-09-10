import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative } from 'node:path';
import type { Service } from '../catalog/loader.js';
import { AndroidAppSchema } from './config.js';

export interface AdbResult { code: number; stdout: string; stderr: string }

/** Finite subprocess; never invoke the host shell or kill the shared ADB server. */
export function runAdb(adb: string, cwd: string, args: string[]): Promise<AdbResult> {
  return new Promise((resolve, reject) => {
    execFile(adb, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 64 * 1024 },
      (error, stdout, stderr) => {
        if (error && (typeof error.code !== 'number' || error.killed)) { reject(error); return; }
        resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
      });
  });
}

export async function androidTarget(service: Service) {
  const config = AndroidAppSchema.parse(service.android);
  if (!service.cwd || !isAbsolute(service.cwd) || !isAbsolute(config.adb)) {
    throw new Error('Android service requires absolute cwd and adb paths');
  }
  const cwd = await realpath(service.cwd);
  // Linked worktrees have a .git file. Only the owning repository may launch.
  if (!(await stat(join(cwd, '.git'))).isDirectory()) throw new Error('Android launch requires repository body, not a worktree');
  const adb = await realpath(config.adb);
  if (!['adb', 'adb.exe'].includes(basename(adb).toLowerCase()) || !(await stat(adb)).isFile()) {
    throw new Error('Configured adb is not an ADB executable');
  }
  const run = (args: string[]) => runAdb(adb, cwd, ['-s', config.serial, ...args]);
  const state = await run(['get-state']);
  if (state.code !== 0 || state.stdout.trim() !== 'device') throw new Error('Selected Android device is unavailable or unauthorized');
  return { config, cwd, run };
}

export async function repositoryApk(cwd: string, configured: string): Promise<string> {
  const apk = await realpath(isAbsolute(configured) ? configured : join(cwd, configured));
  const local = relative(cwd, apk);
  if (!local || local === '..' || local.startsWith('../') || local.startsWith('..\\') || isAbsolute(local)
      || !apk.toLowerCase().endsWith('.apk') || !(await stat(apk)).isFile()) {
    throw new Error('APK must be a file inside the owning repository');
  }
  return apk;
}
