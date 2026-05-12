/**
 * auto-fix エンジン向けの起動者設定。
 *
 * Excubitor は LUDIARS 起動チェーンの先頭にいるので、 LLM CLI のパスや bash パスを
 * Infisical から取らず、 本ファイルでサービス起動者が設定する想定。
 */

export const autoFixConfig = {
  /**
   * Claude Code CLI のフルパス、 もしくは PATH 上のコマンド名。
   * `where claude` で確認可。
   */
  claudeCli: process.env.CLAUDE_CLI_PATH ?? 'claude',

  /**
   * Claude Code が child process spawn で必要とする git-bash の path (Windows)。
   * feedback_claude_cli_windows_bash.md 参照。
   */
  claudeBashPath:
    process.env.CLAUDE_CODE_GIT_BASH_PATH ??
    'C:\\Program Files\\Git\\bin\\bash.exe',

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
