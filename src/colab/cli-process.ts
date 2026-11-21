import { spawn } from 'node:child_process';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { readBoundedFile } from './artifact-integrity.js';

const MAX_OUTPUT = 256 * 1024;
const MAX_SETTINGS_BYTES = 16 * 1024;

export interface ColabCommand {
  cliPath: string;
  osUser: string;
  args: string[];
  cwd: string;
  signal: AbortSignal;
  capture?: boolean;
}
export type ColabProcess = (command: ColabCommand) => Promise<{ ok: boolean; stdout: string; stderrObserved?: boolean }>;

export const runColabProcess: ColabProcess = async ({ cliPath, osUser, args, cwd, signal, capture }) => {
  const user = userInfo();
  if ((process.platform !== 'darwin' && process.platform !== 'linux') || user.uid === 0 || user.username !== osUser ||
      signal.aborted || !await updateCheckDisabled(user.homedir) || signal.aborted) return { ok: false, stdout: '' };

  return new Promise((resolve) => {
    const child = spawn(cliPath, args, {
      cwd, shell: false, detached: true, windowsHide: true,
      stdio: ['ignore', capture ? 'pipe' : 'ignore', capture ? 'pipe' : 'ignore'],
      env: { HOME: user.homedir, USER: user.username, LOGNAME: user.username, PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', NO_COLOR: '1' },
    });
    let size = 0;
    let failed = false;
    let stderrObserved = false;
    const chunks: Buffer[] = [];
    const kill = () => {
      failed = true;
      if (child.pid === undefined) return;
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch { /* The process group may have exited between abort and kill. */ }
    };
    signal.addEventListener('abort', kill, { once: true });
    if (signal.aborted) kill();
    child.stdout?.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_OUTPUT) kill();
      else chunks.push(chunk);
    });
    child.stderr?.on('data', () => { stderrObserved = true; });
    child.once('error', () => { failed = true; });
    child.once('close', code => {
      signal.removeEventListener('abort', kill);
      const ok = code === 0 && !failed;
      resolve({ ok, stdout: ok ? Buffer.concat(chunks).toString('utf8') : '', stderrObserved });
    });
  });
};

async function updateCheckDisabled(home: string): Promise<boolean> {
  // This is the CLI's update preferences file. The CLI alone owns OAuth and session state.
  try {
    const bytes = await readBoundedFile(join(home, '.config', 'colab-cli', 'settings.json'), MAX_SETTINGS_BYTES);
    const settings: unknown = JSON.parse(bytes.toString('utf8'));
    return !!settings && typeof settings === 'object' && 'enable_update_check' in settings && settings.enable_update_check === false;
  } catch {
    return false;
  }
}
