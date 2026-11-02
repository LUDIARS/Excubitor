import { execFile, type ExecFileOptionsWithStringEncoding } from 'node:child_process';
import type { ExecResult } from '../shared/exec.js';

export type ArchiveRunOptions = ExecFileOptionsWithStringEncoding & { cwd: string; shell: false };
export type ArchiveRunner = (cmd: string, args: string[], options: ArchiveRunOptions) => Promise<ExecResult>;

/** execFile owns process completion and timeout cleanup; no command shell is involved. */
export const defaultArchiveRunner: ArchiveRunner = (cmd, args, options) => new Promise((resolve) => {
  execFile(cmd, args, { ...options, shell: false, windowsHide: true }, (error, stdout, stderr) => {
    resolve({ ok: !error, code: error ? (typeof error.code === 'number' ? error.code : null) : 0,
      stdout, stderr: error ? stderr || error.message : stderr });
  });
});
