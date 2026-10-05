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
/** 拠点ごとの host 上書き (`code=host,code=host`)。 catalog は全拠点共有なので拠点差は env に置く。 */
export const TOPOLOGY_HOSTS_ENV = 'EXCUBITOR_TOPOLOGY_HOSTS';
const HOST_PATTERN = /^[A-Za-z0-9.-]{1,253}$/;

let cached: Record<string, string> = {};

/** code → 環境変数キー (大文字 + 非英数を `_`)。 例 cernere-backend-dev → CERNERE_BACKEND_DEV */
export function envKey(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

/**
 * `EXCUBITOR_TOPOLOGY_HOSTS` を code → host に解析する (pure)。 他拠点で動くサービス
 * (例 `cernere=100.84.227.24` = Mac の Tailscale アドレス) を全サービスへ配る URL に反映するため。
 * 形式が不正な項目は捨てず起動時に気付けるよう例外にする。
 */
export function parseTopologyHosts(raw: string | undefined): Record<string, string> {
  const hosts: Record<string, string> = {};
  for (const item of (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [code, host, ...rest] = item.split('=').map((s) => s.trim());
    if (!code || !host || rest.length > 0 || !HOST_PATTERN.test(host)) {
      throw new Error(`${TOPOLOGY_HOSTS_ENV} の項目が不正です: "${item}" (code=host で指定)`);
    }
    hosts[code] = host;
  }
  return hosts;
}

/** template の `${port}` / `${host}` を展開する。 host は拠点の上書きが無ければ localhost。 */
function render(template: string, svc: Service, host: string): string {
  const p = svc.port != null ? String(svc.port) : '';
  return template.replace(/\$\{port\}/g, p).replace(/\$\{host\}/g, host);
}

/** catalog から topology env map を構築する (pure)。 */
export function buildTopologyEnv(catalog: Catalog, hosts: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  const hostOf = (svc: Service): string => hosts[svc.code] ?? DEFAULT_HOST;

  // 1. 自動導出 (<CODE>_URL / <CODE>_PORT)。
  for (const svc of catalog.services) {
    if (svc.port == null) continue;
    const key = envKey(svc.code);
    env[`${key}_PORT`] = String(svc.port);
    env[`${key}_URL`] = `http://${hostOf(svc)}:${svc.port}`;
  }

  // 2. 明示 provides (正規名、 自動導出を上書き)。
  for (const svc of catalog.services) {
    if (!svc.provides) continue;
    for (const [name, template] of Object.entries(svc.provides)) {
      env[name] = render(template, svc, hostOf(svc));
    }
  }

  return env;
}

/**
 * boot / catalog reload 時に呼び、 topology をキャッシュする。
 * 上書き env が不正なら警告して上書きなし (localhost) で続ける。 Excubitor 自体は止めない。
 */
export function setTopologyFromCatalog(catalog: Catalog, env: NodeJS.ProcessEnv = process.env): void {
  let hosts: Record<string, string> = {};
  try {
    hosts = parseTopologyHosts(env[TOPOLOGY_HOSTS_ENV]);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'topology host override ignored');
  }
  cached = buildTopologyEnv(catalog, hosts);
}

/** 注入用 topology env (キャッシュ済み)。 */
export function getTopologyEnv(): Record<string, string> {
  return cached;
}
