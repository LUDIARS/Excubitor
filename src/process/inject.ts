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
import { type Service } from '../catalog/loader.js';
import { createNamedLogger } from '../shared/logger.js';
import { readIdentity, fetchProjectSecrets, toEnvMap, hasIdentity } from '../secrets/infisical.js';
import { resolveServiceInfisical } from '../secrets/config-store.js';

const logger = createNamedLogger('excubitor.process.inject');

export { hasIdentity };

/**
 * spawn する子プロセスに渡す env を解決する。
 * - infisical 設定が無い / inject:false → 空 (= 親 env のみ)
 * - identity 不足 → throw (preflight で事前検知させる)
 * - fetch 失敗 → throw
 */
export async function resolveInjectEnv(svc: Service): Promise<Record<string, string>> {
  const cfg = resolveServiceInfisical(svc.code, svc.infisical);
  if (!cfg || !cfg.inject) return {};

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
  logger.info({ code: svc.code, project: cfg.project_id, injected: Object.keys(env).length }, 'resolved inject env');
  return env;
}
