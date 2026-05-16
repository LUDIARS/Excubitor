/**
 * auto-fix エンジン向けの起動者設定。
 *
 * Excubitor は LUDIARS 起動チェーンの先頭にいるので、 LLM CLI のパスや bash パスを
 * Infisical から取らず、 本ファイルでサービス起動者が設定する想定。
 */

import { existsSync } from 'node:fs';
import os from 'node:os';

function resolveBashPath(): string {
  if (process.env.CLAUDE_CODE_GIT_BASH_PATH) return process.env.CLAUDE_CODE_GIT_BASH_PATH;
  if (process.platform !== 'win32') return '/bin/bash';

  // Windows ユーザの典型的な bash 実体を順に試す。
  // SourceTree 同梱 / Git for Windows / WSL / msys2 等。
  const home = os.homedir();
  const oneDrive = process.env.OneDrive ?? '';
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    `${home}\\AppData\\Local\\Atlassian\\SourceTree\\git_local\\usr\\bin\\bash.exe`,
    `${home}\\AppData\\Local\\Atlassian\\SourceTree\\git_local\\bin\\bash.exe`,
    oneDrive && `${oneDrive}\\ドキュメント\\Atlassian\\SourceTree\\git_local\\bin\\bash.exe`,
    `${home}\\AppData\\Local\\Programs\\Git\\bin\\bash.exe`,
    'C:\\msys64\\usr\\bin\\bash.exe',
  ].filter(Boolean) as string[];

  for (const c of candidates) {
    try {
      if (existsSync(c)) return c;
    } catch { /* ignore */ }
  }
  // fallback: 古い既定 (存在しなくても文字列として返す。 起動時に失敗ログが出る)
  return 'C:\\Program Files\\Git\\bin\\bash.exe';
}

export const autoFixConfig = {
  /**
   * Claude Code CLI のフルパス、 もしくは PATH 上のコマンド名。
   */
  claudeCli: process.env.CLAUDE_CLI_PATH ?? 'claude',

  /**
   * Claude Code が child process spawn で必要とする git-bash の path (Windows)。
   * 環境変数 CLAUDE_CODE_GIT_BASH_PATH 優先、 未設定なら典型的なパスを auto-detect。
   * feedback_claude_cli_windows_bash.md / feedback_concordia_bash_path.md 参照。
   */
  claudeBashPath: resolveBashPath(),

  /**
   * Claude Code に渡すプロンプトの最大長 (これを超えたら log_excerpt を末尾切り)。
   */
  promptMaxChars: 16_000,

  /**
   * Claude Code 子プロセスの timeout (ms)。 これを超えたら kill。
   */
  cliTimeoutMs: 10 * 60 * 1000,  // 10 min

  /**
   * Claude Code 終了後、 verify 用にサービスを restart して health probe を待つタイムアウト。
   */
  verifyTimeoutMs: 90 * 1000,    // 90 sec
} as const;
