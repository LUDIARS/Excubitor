import { arsRoot, domainRoot } from '../shared/roots.js';

/**
 * catalog テキスト内の `${ARS_ROOT}` / `${DOMAIN_ROOT}` をマシン依存の実値に補間する。
 *
 * catalog (services.yaml) にも各サービスリポの断片 (excubitor.catalog.yaml) にも
 * ドライブ / ドメインを焼き込まないための単一補間点。 loader と fragments で共用する。
 */
export function interpolateRoots(raw: string): string {
  return raw.replaceAll('${ARS_ROOT}', arsRoot()).replaceAll('${DOMAIN_ROOT}', domainRoot());
}
