/**
 * SafeMode — 起動時に何もサービスを起動せず、 Excubitor 本体 (監視 / スキャン /
 * Web GUI / 制御 API) だけを立ち上げるモード。
 *
 * 有効化:
 *   - 環境変数 `EXCUBITOR_SAFE_MODE=1`
 *   - 起動引数 `--safe`
 *
 * SafeMode では `runAutostart` と保存済み launch profile の auto-launch を両方
 * スキップする。 起動後は Monitor / Launch タブから手動で起動できる
 * (制御 API 自体は通常どおり動く)。
 */

/** boot 時に env / argv から SafeMode を判定する (純関数、 テスト用に引数で注入可)。 */
export function detectSafeMode(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv,
): boolean {
  if (env.EXCUBITOR_SERVICE_MODE === '1' || argv.includes('--service')) return false;
  return env.EXCUBITOR_SAFE_MODE === '1' || argv.includes('--safe');
}

export function detectServiceMode(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv,
): boolean {
  return env.EXCUBITOR_SERVICE_MODE === '1' || argv.includes('--service');
}

let safeMode = false;

/** boot 時に 1 度だけ設定する。 */
export function setSafeMode(value: boolean): void {
  safeMode = value;
}

/** 現在 SafeMode かどうか (router / health から参照)。 */
export function isSafeMode(): boolean {
  return safeMode;
}

/**
 * LogSafeMode — ログ購読/集積系を全て止めて backend を起動するモード。
 *
 * 有効化:
 *   - 環境変数 `EXCUBITOR_LOG_SAFE_MODE=1`
 *   - 起動引数 `--no-logs`
 *
 * 止まるもの: file-tail (Vestigium JSONL) / process-log-tail (data/process-logs)
 * / error-detector / parquet 圧縮。 加えて自身の pino レベルを warn へ落とす
 * (EXCUBITOR_LOG_LEVEL 明示時はそちらを優先)。
 * 監視 / 制御 API / WebUI / ログの読み出し (DB 参照) は通常どおり動く。
 *
 * 用途: ログ I/O が原因の障害切り分け (例: 2026-08-02 の Defender エンジン
 * ハングで process-logs の open が永久ブロックし backend が無応答化した事故)。
 */
export function detectLogSafeMode(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv,
): boolean {
  return env.EXCUBITOR_LOG_SAFE_MODE === '1' || argv.includes('--no-logs');
}

let logSafeMode = false;

/** boot 時に 1 度だけ設定する。 */
export function setLogSafeMode(value: boolean): void {
  logSafeMode = value;
}

/** 現在 LogSafeMode かどうか (health / UI 表示から参照)。 */
export function isLogSafeMode(): boolean {
  return logSafeMode;
}
