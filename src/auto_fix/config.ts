/**
 * Startup configuration for the auto-fix engine.
 *
 * Excubitor starts before other services; CLI and bash paths must be available locally.
 * Resolve them from startup environment and local defaults.
 */

import { existsSync } from 'node:fs';
import os from 'node:os';

function resolveBashPath(): string {
  if (process.env.CLAUDE_CODE_GIT_BASH_PATH) return process.env.CLAUDE_CODE_GIT_BASH_PATH;
  if (process.platform !== 'win32') return '/bin/bash';

  // Try common Windows bash installation paths.
  // SourceTree 同梱 / Git for Windows / WSL / msys2 等、E
  const home = os.homedir();
  const oneDrive = process.env.OneDrive ?? '';
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    `${home}\\AppData\\Local\\Atlassian\\SourceTree\\git_local\\usr\\bin\\bash.exe`,
    `${home}\\AppData\\Local\\Atlassian\\SourceTree\\git_local\\bin\\bash.exe`,
    oneDrive && `${oneDrive}\\ドキュメンチE\Atlassian\\SourceTree\\git_local\\bin\\bash.exe`,
    `${home}\\AppData\\Local\\Programs\\Git\\bin\\bash.exe`,
    'C:\\msys64\\usr\\bin\\bash.exe',
  ].filter(Boolean) as string[];

  for (const c of candidates) {
    try {
      if (existsSync(c)) return c;
    } catch { /* ignore */ }
  }
  // Return the default path even if absent; startup will report the failure.
  return 'C:\\Program Files\\Git\\bin\\bash.exe';
}

export const autoFixConfig = {
  /**
   * Full Claude Code CLI path or command name on PATH.
   */
  claudeCli: process.env.CLAUDE_CLI_PATH ?? 'claude',

  /**
   * Git-bash path used by Claude Code child processes on Windows.
   * Prefer CLAUDE_CODE_GIT_BASH_PATH; otherwise detect common paths.
   * See the Windows bash path feedback documents.
   */
  claudeBashPath: resolveBashPath(),

  /**
   * Maximum prompt length; callers trim log excerpts to fit.
   */
  promptMaxChars: 16_000,

  /**
   * Claude Code child process timeout in milliseconds.
   */
  cliTimeoutMs: 10 * 60 * 1000,  // 10 min

  /**
   * Timeout for post-fix service restart and health verification.
   */
  verifyTimeoutMs: 90 * 1000,    // 90 sec
} as const;


