/**
 * service spawn 時に Infisical から secret を fetch して env として注入するための
 * 解決ロジック。 fetch した secret はこの関数の戻り値経由でメモリにのみ存在し、
 * ファイルに書き出されない (設計書 §7.2)。
 */
import { type Service } from '../catalog/loader.js';
import * as infisical from '../infisical/client.js';
import { applyInjectFilter } from '../infisical/filter.js';

export async function resolveInjectEnv(svc: Service): Promise<Record<string, string>> {
  if (!svc.infisical?.inject) return {};
  if (!infisical.isBootstrapped()) {
    throw new Error(
      `Infisical not bootstrapped: ${svc.code} requires inject. POST /api/v1/infisical/bootstrap first.`,
    );
  }
  const all = await infisical.fetchSecretsForInject(
    svc.infisical.project_id,
    svc.infisical.environment,
  );
  return applyInjectFilter(all, {
    prefix: svc.infisical.prefix,
    include: svc.infisical.include,
    exclude: svc.infisical.exclude,
  });
}
