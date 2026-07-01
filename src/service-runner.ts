import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const root = process.cwd();
const logsDir = join(root, 'logs');
mkdirSync(logsDir, { recursive: true });

const children: ChildProcess[] = [];

function npmCmd(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function start(name: string, command: string, args: string[], env: NodeJS.ProcessEnv = process.env): void {
  const child = spawn(command, args, {
    cwd: root,
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  });
  children.push(child);
  child.on('exit', (code, signal) => {
    console.error(`[service-runner] ${name} exited code=${code ?? '-'} signal=${signal ?? '-'}`);
    shutdown(code ?? 1);
  });
}

function shutdown(code = 0): void {
  for (const child of children) {
    try { child.kill('SIGTERM'); } catch { /* noop */ }
  }
  setTimeout(() => process.exit(code), 500);
}

const serviceEnv = {
  ...process.env,
  EXCUBITOR_SERVICE_MODE: '1',
  EXCUBITOR_SAFE_MODE: '0',
};

start('backend', process.execPath, ['dist/server.js', '--service'], serviceEnv);
start('frontend', npmCmd(), ['--prefix', 'frontend', 'run', 'preview', '--', '--host', '127.0.0.1', '--port', '17333'], serviceEnv);

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
setInterval(() => undefined, 60_000);
