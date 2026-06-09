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
  return env.EXCUBITOR_SAFE_MODE === '1' || argv.includes('--safe');
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
