/**
 * サービストポロジ env の導出。
 *
 * Excubitor は catalog から各サービスの host/port を知っている。 その「Excubitor が
 * 特定可能な情報」 (URL / port) を env として全サービスの spawn 時に注入することで、
 * 各サービスが他サービスの接続先を個別設定しなくて済むようにする
 * (特に Cernere URL は毎サービスで必要なので、 catalog 1 箇所の定義で全体に配る)。
 *
 * 2 系統:
 *   1. 自動導出: port を持つ全サービスに `<CODE>_URL` / `<CODE>_PORT`
 *      (CODE = code を大文字 + 非英数を `_` 化)。
 *   2. 明示 `provides`: catalog の各サービスが公開する正規名 (CERNERE_URL 等)。
 *      `${port}` / `${host}` を展開。 自動導出より優先。
 *
 * secret ではない (URL/port は公開情報) ため Infisical ではなくここで扱う。
 * secret は [infisical relay] が別途解決し、 topology に上書きマージされる。
 */

import type { Catalog, Service } from '../catalog/loader.js';
import { createNamedLogger } from '../shared/logger.js';

const logger = createNamedLogger('excubitor.process.topology');

const DEFAULT_HOST = 'localhost';

let cached: Record<string, string> = {};

/** code → 環境変数キー (大文字 + 非英数を `_`)。 例 cernere-backend-dev → CERNERE_BACKEND_DEV */
export function envKey(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

/** template の `${port}` / `${host}` を展開する。 host は当面 localhost 固定。 */
function render(template: string, svc: Service): string {
  const p = svc.port != null ? String(svc.port) : '';
  return template.replace(/\$\{port\}/g, p).replace(/\$\{host\}/g, DEFAULT_HOST);
}

/** catalog から topology env map を構築する (pure)。 */
export function buildTopologyEnv(catalog: Catalog): Record<string, string> {
  const env: Record<string, string> = {};

  // 1. 自動導出 (<CODE>_URL / <CODE>_PORT)。
  for (const svc of catalog.services) {
    if (svc.port == null) continue;
    const key = envKey(svc.code);
    env[`${key}_PORT`] = String(svc.port);
    env[`${key}_URL`] = `http://${DEFAULT_HOST}:${svc.port}`;
  }

  // 2. 明示 provides (正規名、 自動導出を上書き)。
  for (const svc of catalog.services) {
    if (!svc.provides) continue;
    for (const [name, template] of Object.entries(svc.provides)) {
      env[name] = render(template, svc);
    }
  }

  return env;
}

/** boot / catalog reload 時に呼び、 topology をキャッシュする。 */
export function setTopologyFromCatalog(catalog: Catalog): void {
  cached = buildTopologyEnv(catalog);
  logger.info({ count: Object.keys(cached).length }, 'topology env built');
}

/** 注入用 topology env (キャッシュ済み)。 */
export function getTopologyEnv(): Record<string, string> {
  return cached;
}
