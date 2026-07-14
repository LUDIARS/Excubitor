/**
 * catalog service のコードルックアップ。
 *
 * cross-service secret delegation (`requires_secret`) は「他サービスの infisical 設定」を
 * code から引く必要があるが、 inject.ts は catalog 全体を持たない。 topology.ts が
 * `setTopologyFromCatalog` で catalog snapshot をキャッシュしているのと同じパターンで、
 * code → Service のルックアップだけを単一責任で保持する。
 */
import type { Service } from '../catalog/loader.js';

let services = new Map<string, Service>();

/** boot / catalog reload 時に呼び、 code → Service のルックアップをキャッシュする。 */
export function setCatalogServices(list: Service[]): void {
  services = new Map(list.map((svc) => [svc.code, svc]));
}

/** catalog code から Service を引く。 未登録なら undefined (呼び出し側が fail-fast する)。 */
export function getServiceByCode(code: string): Service | undefined {
  return services.get(code);
}
