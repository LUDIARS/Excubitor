/**
 * `ergo_pkg watch` の引数を組み立てる (純粋関数)。
 *
 * Revisor / Concordia の URL は catalog のサービスの port から loopback で作る (Ergo は loopback 以外を
 * 終了 2 で拒否する)。 ポートの数字はコードに持たない。 トークンは渡さない (読み取りは認可不要)。
 *
 * @implements SPEC-ERGO-WATCH-DELIVERY
 */

import type { Catalog } from '../../catalog/loader.js';
import type { WatchHost } from './types.js';

export interface WatchEndpoints {
  revisorUrl: string | null;
  concordiaUrl: string | null;
}

export interface WatchArgsInput {
  hosts: WatchHost[];
  stateDir: string;
  outDir: string;
  endpoints: WatchEndpoints;
}

/** catalog の code から `http://127.0.0.1:<port>` を作る。 サービスが無い・port が無ければ null。 */
export function loopbackServiceUrl(catalog: Catalog, code: string): string | null {
  const service = catalog.services.find((entry) => entry.code === code && !entry.disabled);
  if (!service || service.port == null) return null;
  return `http://127.0.0.1:${service.port}`;
}

export function resolveWatchEndpoints(
  catalog: Catalog,
  codes: { revisor: string; concordia: string },
): WatchEndpoints {
  return {
    revisorUrl: loopbackServiceUrl(catalog, codes.revisor),
    concordiaUrl: loopbackServiceUrl(catalog, codes.concordia),
  };
}

/** `watch --host <dir>... --state <dir> --out <dir> [--revisor-url u] [--concordia-url u]`。 */
export function buildWatchArgs(input: WatchArgsInput): string[] {
  const args = ['watch'];
  for (const host of input.hosts) args.push('--host', host.dir);
  args.push('--state', input.stateDir, '--out', input.outDir);
  if (input.endpoints.revisorUrl) args.push('--revisor-url', input.endpoints.revisorUrl);
  if (input.endpoints.concordiaUrl) args.push('--concordia-url', input.endpoints.concordiaUrl);
  return args;
}
