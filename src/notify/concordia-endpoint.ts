/**
 * Excubitor から Concordia の受け口 (`/v1/events/*`) へ送るときの URL・timeout・ヘッダ。
 *
 * service-deployed の通知と ergo-watch の配送で共用する。 URL は `EXCUBITOR_CONCORDIA_URL`
 * (既定 loopback)、 共有の `x-excubitor-token` は `EXCUBITOR_CONCORDIA_DISPATCH_TOKEN` があるときだけ載せる
 * (Concordia は loopback で動くとき token 無しを受ける)。
 */

export function concordiaUrl(path: string): string {
  const base = process.env.EXCUBITOR_CONCORDIA_URL || 'http://127.0.0.1:11111';
  return new URL(path, base.endsWith('/') ? base : `${base}/`).toString();
}

export function concordiaTimeoutMs(): number {
  const raw = Number(process.env.EXCUBITOR_CONCORDIA_TIMEOUT_MS ?? '10000');
  return Number.isFinite(raw) && raw > 0 ? raw : 10000;
}

export function concordiaHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = process.env.EXCUBITOR_CONCORDIA_DISPATCH_TOKEN;
  if (token) headers['x-excubitor-token'] = token;
  return headers;
}
