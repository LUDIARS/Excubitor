/** Vault-only process env injection; never writes plaintext env files. */
import path from 'node:path';
import { type Service } from '../catalog/loader.js';
import { createNamedLogger } from '../shared/logger.js';
import { getServiceRuntimeConfig, resolveServiceInfisical } from '../secrets/config-store.js';
import { sharedLogsRoot } from '../log/logs-root.js';
import { arsRoot } from '../shared/roots.js';
import { getTopologyEnv } from './topology.js';
import { injectServiceRuntimeVersion } from './service-version.js';
import { resolveVaultEnv } from '../vault/vault-inject.js';
import { planRequiresSecret } from './requires-secret-plan.js';

const logger = createNamedLogger('excubitor.process.inject');

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

function runtimeConfigEnvFor(svc: Pick<Service, 'code'>): Record<string, string> {
  const config = getServiceRuntimeConfig(svc.code);
  if (config === null) return {};
  return { EXCUBITOR_SERVICE_CONFIG_JSON: JSON.stringify(config) };
}

/** Resolve requirements only through the consumer's own Vault bindings. */
export async function resolveRequiresSecretEnv(
  svc: Service,
  vaultEnv?: Record<string, string>,
): Promise<Record<string, string>> {
  const requests = svc.requires_secret ?? [];
  if (requests.length === 0) return {};

  const plan = planRequiresSecret(requests, vaultEnv ?? (await resolveVaultEnv(svc.code)));
  const vaultKeys = Object.keys(plan.fromVault);
  if (vaultKeys.length > 0) {
    // キー名だけ残す (値は出さない)。
    logger.info({ consumer: svc.code, keys: vaultKeys }, 'requires_secret satisfied from Vault');
  }
  if (plan.remaining.length === 0) return plan.fromVault;

  throw new Error(
    `service ${svc.code} missing required Vault bindings or values: ` +
      plan.remaining.flatMap((r) => r.keys).join(', '),
  );
}

/** Resolve Vault-only child env, preserving runtime config and topology priority.
 * @implements SPEC-SERVICE-RUNTIME-VERSION
 */
export async function resolveInjectEnv(svc: Service): Promise<Record<string, string>> {
  const topology = getTopologyEnv();
  // サービス固有の静的 env (catalog の env:)。 topology より優先 (port 上書き等)。
  const staticEnv = svc.env ?? {};
  // config.enc に保存された service 固有 config。値は対象 child process
  // だけに渡し、管理 API / ログには本文を返さない。
  const runtimeConfigEnv = runtimeConfigEnvFor(svc);
  // 共有ルート / Vestigium ログ先 (最低優先 — catalog env: / secret で上書き可)。
  const arsRootEnv = arsRootEnvFor();
  const vestigiumEnv = vestigiumEnvFor(svc);

  const vaultEnv = await resolveVaultEnv(svc.code);
  // Legacy inject is a migration requirement, never permission to fetch Infisical.
  if (resolveServiceInfisical(svc.code, svc.infisical)?.inject && Object.keys(vaultEnv).length === 0) {
    throw new Error(`service ${svc.code} requires Vault bindings before legacy inject can be retired`);
  }
  const requiresSecretEnv = await resolveRequiresSecretEnv(svc, vaultEnv);
  // 優先順位: ars-root < vestigium < global < topology < 静的 env (catalog)
  //           < encrypted runtime config < requires_secret < Vault。
  return (await injectServiceRuntimeVersion(
    svc,
    {
      ...arsRootEnv,
      ...vestigiumEnv,
      ..._globalEnv,
      ...topology,
      ...staticEnv,
      ...runtimeConfigEnv,
      ...requiresSecretEnv,
      ...vaultEnv,
    },
  )).env;
}
