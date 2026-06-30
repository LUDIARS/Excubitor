/**
 * service spawn 時の env 注入解決 (Infisical relay).
 *
 * Excubitor が「ランチャー兼 secret relay」として、 起動する子プロセスに env を配る。
 * catalog の `infisical.inject: true` なサービスは、 Excubitor 自身の machine identity で
 * 該当 project の secret を fetch し、 prefix/include/exclude を適用して env map を返す。
 * 各サービスはこれを process.env として受け取るので、 自前 Infisical fetch が不要になる。
 *
 * (2026-06-04 方針転換: 旧「各サービス自前 fetch」 から Excubitor relay へ戻した)
 */
import path from 'node:path';
import { type Service } from '../catalog/loader.js';
import { createNamedLogger } from '../shared/logger.js';
import { readIdentity, fetchProjectSecrets, toEnvMap, hasIdentity } from '../secrets/infisical.js';
import { resolveServiceInfisical } from '../secrets/config-store.js';
import { sharedLogsRoot } from '../log/logs-root.js';
import { arsRoot } from '../shared/roots.js';
import { getTopologyEnv } from './topology.js';

const logger = createNamedLogger('excubitor.process.inject');

export { hasIdentity };

/** catalog の `global.env` から設定されるグローバル env。 起動時 / catalog reload 時に更新。 */
let _globalEnv: Record<string, string> = {};

/** catalog reload 後に呼び出して全サービス共通 env を更新する。 */
export function setGlobalEnv(env: Record<string, string>): void {
  _globalEnv = env;
}

/**
 * Vestigium ログ先を spawn 子に伝える env。 **全サービスに共有ルート `<root>` を渡す**。
 * サービス側 Vestigium は `<root>/<code>/` に書き、 Excubitor の file-tail がそこを自動発見して
 * tail する (= log_path を catalog に明示しなくても全サービスのログが log bus に乗る)。
 *
 * catalog に `log_path` (= `<root>/<code>` 規約) があればその親を優先 (個別に root をずらしたい
 * サービス向けの上書き)。 無ければ `sharedLogsRoot()` を既定にする。 純関数 (テスト可能)。
 */
export function vestigiumEnvFor(svc: Pick<Service, 'log_path'>): Record<string, string> {
  const root = svc.log_path ? path.dirname(svc.log_path) : sharedLogsRoot();
  return { VESTIGIUM_LOGS_DIR: root };
}

/**
 * LUDIARS ワークスペースルートを spawn 子に伝える env。 **全サービスに共有ルート `<root>` を渡す**。
 *
 * これまで各サービスが作業ディレクトリ (workspace root / spawn cwd) を `E:\Document\Ars` 等で
 * 直書きしており、 別ドライブ (D:\LUDIARS) のマシンで壊れていた。 ルートの正本は Excubitor の
 * `arsRoot()` (env `EXCUBITOR_ARS_ROOT` / `LUDIARS_ROOT` → cwd 親) なので、 それを `LUDIARS_ROOT`
 * として子へ注入し、 各サービスはこの env を基準に作業ディレクトリを決める (ドライブ非依存)。
 *
 * 純関数 (テスト可能)。 `.env` ファイルには依存せず、 プロセス env として配る。
 */
export function arsRootEnvFor(): Record<string, string> {
  return { LUDIARS_ROOT: arsRoot() };
}

/**
 * spawn する子プロセスに渡す env を解決する。
 * - 常に topology env (URL/port、 Excubitor が catalog から特定可能な情報) を含む
 * - infisical inject 設定があれば secret を fetch して topology に上書きマージ
 * - identity 不足 (infisical inject 要求時) → throw (preflight で事前検知させる)
 * - fetch 失敗 → throw
 */
export async function resolveInjectEnv(svc: Service): Promise<Record<string, string>> {
  const topology = getTopologyEnv();
  // サービス固有の静的 env (catalog の env:)。 topology より優先 (port 上書き等)。
  const staticEnv = svc.env ?? {};
  // 共有ルート / Vestigium ログ先 (最低優先 — catalog env: / secret で上書き可)。
  const arsRootEnv = arsRootEnvFor();
  const vestigiumEnv = vestigiumEnvFor(svc);

  const cfg = resolveServiceInfisical(svc.code, svc.infisical);
  // 優先順位: ars-root < vestigium < global < topology < 静的 env (catalog) < secret。
  if (!cfg || !cfg.inject) return { ...arsRootEnv, ...vestigiumEnv, ..._globalEnv, ...topology, ...staticEnv };

  const id = readIdentity();
  if (!id) {
    throw new Error(
      `service ${svc.code} requires Infisical inject but Excubitor has no machine identity ` +
        `(set INFISICAL_SITE_URL / INFISICAL_CLIENT_ID / INFISICAL_CLIENT_SECRET)`,
    );
  }

  const secrets = await fetchProjectSecrets(id, cfg.project_id, cfg.environment);
  const env = toEnvMap(secrets, {
    prefix: cfg.prefix,
    include: cfg.include,
    exclude: cfg.exclude,
  });
  logger.info(
    { code: svc.code, project: cfg.project_id, secrets: Object.keys(env).length, topology: Object.keys(topology).length },
    'resolved inject env (topology + infisical)',
  );
  // 優先順位: ars-root < vestigium < global < topology < 静的 env (catalog) < secret。
  return { ...arsRootEnv, ...vestigiumEnv, ..._globalEnv, ...topology, ...staticEnv, ...env };
}
