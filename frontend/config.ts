/**
 * Excubitor frontend 起動設定。
 *
 * Excubitor は LUDIARS 起動チェーンの最先頭にあり、 他サービスのように
 * Infisical / Cernere に問い合わせて設定を引くことが (chicken-and-egg のため)
 * できない。 本ファイルが唯一の単方向 source of truth。
 *
 * **サービス起動者がリポをチェックアウトしたら、 本ファイルを直接編集する想定**。
 *
 *   - Cloudflare Tunnel / reverse proxy 経由でアクセスするドメインがあれば
 *     `allowedHosts` に追加する。
 *   - 別 host で backend を立てる場合 `backendUrl` を書き換える。
 *
 * 機密情報は入れない (Infisical を介さず git に乗るため)。 ドメイン名や
 * port のような公開して問題ない値のみ。
 */

export const config = {
  /**
   * Vite dev server が受け入れる Host ヘッダ。
   * localhost 以外でアクセスする場合 (Cloudflare Tunnel / Tailscale 公開等) に追加。
   * 環境変数 `EXCUBITOR_ALLOWED_HOSTS` (カンマ区切り) でも追記可。
   */
  allowedHosts: [
    'localhost',
    'excubitor.vtn-game.com',
  ],

  /**
   * frontend dev server の listen port。
   * 変更時は dev-process.md / Concordia 等の参照側も更新すること。
   * 17331 は Concordia の Vite WebUI が strictPort で占有するため使用しない
   * (衝突すると Concordia WebUI が起動できず 404 になる)。 backend=17332 / frontend=17333。
   */
  port: 17333,

  /**
   * `/api/*` を proxy する backend (Excubitor server) の URL。
   * 同一ホスト上で server を動かしている前提 (LUDIARS standard)。
   * backend は server.ts の既定 (EXCUBITOR_PORT ?? 17332) に揃える。
   */
  backendUrl: 'http://localhost:17332',
} as const;

/**
 * 環境変数で `EXCUBITOR_ALLOWED_HOSTS` を渡された場合に config.allowedHosts に追記する。
 */
export function resolveAllowedHosts(): string[] {
  const extra = (process.env.EXCUBITOR_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return [...config.allowedHosts, ...extra];
}
