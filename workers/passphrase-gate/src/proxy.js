/** @implements SPEC-PASSPHRASE-GATE (spec/feature/passphrase-gate.md) */
// 認証済みリクエストをそのままオリジンへ通す。Worker のサブリクエストは同じ Worker を再起動しない。

const GATE_COOKIE_PREFIX = "pg_session=";

export function forwardToOrigin(request, session) {
  const headers = new Headers(request.headers);
  const originCookies = stripGateCookie(request.headers.get("cookie"));
  if (originCookies) headers.set("cookie", originCookies);
  else headers.delete("cookie");
  // オリジン側ログでも誰のアクセスか分かるように付ける。
  headers.set("X-Gate-Visitor-Id", session.id);
  headers.set("X-Gate-Visitor-Name", encodeURIComponent(session.name));
  return fetch(new Request(request, { headers }));
}

export function stripGateCookie(header) {
  if (!header) return null;
  const kept = header.split(";").map((s) => s.trim()).filter((s) => s && !s.startsWith(GATE_COOKIE_PREFIX));
  return kept.length ? kept.join("; ") : null;
}
