import type { ViewerTarget } from './catalog.js';

/**
 * 統合ビューは全アプリを 1 つの origin のパス違いで配信している。 cookie の Path はブラウザ内の JS に対する
 * 隔離にならないので、 アプリ A のページ (XSS・悪意ある HTML) が `fetch('/viewer/apps/B/…', {credentials:'include'})`
 * で B の認証済み API を使えてしまう。 origin を分けるまでの最小の封じ込めとして、 要求がどのアプリのページから
 * 出たかを Fetch Metadata と Referer で判定し、 別アプリから出た要求には B の cookie を付けない。
 *
 * - Referer はブラウザが付け、 ページの JS からは偽装できない (消すことはできるので、 消えた要求は別アプリ扱い)。
 *   viewer の応答は Referrer-Policy: same-origin に揃える (headers.ts) ので、 アプリ自身の要求には Referer が付く。
 * - 同じ project の peer (web/API 分割) は同じアプリとして扱う (target.origins の prefix)。
 * - 統合ビューのトップ (/viewer/) からの画面遷移 (iframe・新しいタブ) は通す。
 * - ブックマーク・直接入力 (Sec-Fetch-Site: none) と別サイトからの要求は対象外 (アプリ自身の CSRF 対策と SameSite に任せる)。
 * - WebSocket の handshake には Referer が無いので判定しない (残課題、 spec/feature/viewer-dmz.md)。
 *
 * 同じ origin のページは互いの DOM を直接操作でき (親の統合ビュー経由・window.open)、 history.replaceState で
 * 自分の URL (= Referer) を別アプリのパスに変えることもできる。 狙って作られた攻撃は防げない。 素朴な横取り
 * (他アプリの API を直接 fetch / form 送信) を止める速度制限であり、 完全な隔離はアプリごとの origin
 * (サブドメイン) で行う (spec/feature/viewer-dmz.md の残課題)。
 *
 * @implements EX-VIEWER-DMZ
 */

function allowedPrefixes(target: ViewerTarget): string[] {
  return [...new Set([target.prefix, ...Object.values(target.origins)])];
}

/**
 * Referer の path。 Sec-Fetch-Site: same-origin はブラウザが「要求元と宛先が同じ origin」 と判定した印なので、
 * origin 同士は比べない (cloudflared 越しでは Ex から見える scheme / host が公開 URL と違うことがある)。
 */
function refererPath(headers: Headers): string | null {
  const referer = headers.get('referer');
  if (!referer) return null;
  try { return new URL(referer).pathname; } catch { return null; }
}

/** 同じ origin の別アプリ (またはアプリを特定できないページ) から出た要求か。 */
export function isCrossAppRequest(headers: Headers, target: ViewerTarget): boolean {
  if (headers.get('sec-fetch-site') !== 'same-origin') return false;
  const mode = headers.get('sec-fetch-mode');
  if (mode === 'websocket') return false;
  const path = refererPath(headers);
  if (path === null) return true;
  if (allowedPrefixes(target).some((prefix) => path === prefix || path.startsWith(prefix + '/'))) return false;
  // 統合ビューのトップと Ex の Monitor (Ex が配信するページ) からの画面遷移は通す。
  return !(mode === 'navigate' && (path === '/viewer/' || path.startsWith('/viewer/apps/excubitor/')));
}
