/** @implements SPEC-PASSPHRASE-GATE (spec/feature/passphrase-gate.md) */
// エントリ: ルーティングと認証判定のみ。画面・署名・転送は各モジュールへ委譲。

import { assertPassphraseConfiguration, randomId, verifyPassphrase } from "./crypto.js";
import { htmlResponse, loginPage } from "./pages.js";
import { forwardToOrigin } from "./proxy.js";
import { assertSessionConfiguration, clearCookieHeader, createSessionCookie, readCookie, setCookieHeader, verifySessionCookie } from "./session.js";

const GATE_PREFIX = "/__gate/";
const FAIL_DELAY_MS = 800;

export default {
  async fetch(request, env) {
    assertPassphraseConfiguration(env);
    assertSessionConfiguration(env);
    const url = new URL(request.url);
    if (url.pathname.startsWith(GATE_PREFIX)) return handleGate(request, env, url);

    const session = await verifySessionCookie(env, readCookie(request));
    if (!session) {
      log("challenge", request, { path: url.pathname });
      return challenge(env, url);
    }
    log("access", request, { id: session.id, name: session.name, method: request.method, path: url.pathname });
    return forwardToOrigin(request, session);
  },
};

function challenge(env, url, extra = {}) {
  const next = safeNext(url.pathname + url.search);
  return htmlResponse(loginPage({ title: env.SITE_TITLE ?? "入場", next, ...extra }), 401);
}

async function handleGate(request, env, url) {
  const action = url.pathname.slice(GATE_PREFIX.length);
  if (action === "login" && request.method === "POST") return login(request, env);
  if (action === "logout") {
    const session = await verifySessionCookie(env, readCookie(request));
    log("logout", request, { id: session?.id, name: session?.name });
    return new Response(null, { status: 302, headers: { location: "/", "set-cookie": clearCookieHeader(), "cache-control": "no-store" } });
  }
  return new Response("not found", { status: 404 });
}

async function login(request, env) {
  if (!isSameOriginRequest(request)) return new Response("forbidden", { status: 403 });
  let form;
  try {
    form = await request.formData();
  } catch {
    return new Response("invalid form", { status: 400 });
  }
  const nameText = new TextDecoder().decode(new TextEncoder().encode(String(form.get("name") ?? "").trim()));
  const name = [...nameText].slice(0, 40).join("");
  const next = safeNext(String(form.get("next") ?? "/"));
  const url = new URL(next, request.url);

  if (!name) return challenge(env, url, { error: "なまえを入力してください。" });
  if (!(await verifyPassphrase(form.get("passphrase"), env))) {
    log("login_rejected", request, {});
    await new Promise((r) => setTimeout(r, FAIL_DELAY_MS));
    return challenge(env, url, { error: "あいことばが違います。", name });
  }

  const visitor = { id: randomId(), name };
  log("login", request, visitor);
  const cookie = await createSessionCookie(env, visitor);
  return new Response(null, { status: 303, headers: { location: next, "set-cookie": setCookieHeader(env, cookie), "cache-control": "no-store" } });
}

/** 1 行 JSON。Workers Logs / Logpush でそのまま検索できる形にする。 */
function log(event, request, fields) {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...fields,
      ip: request.headers.get("cf-connecting-ip"),
      country: request.headers.get("cf-ipcountry"),
    }),
  );
}

/** open redirect 防止: 同一オリジンのパスだけ許す。 */
export function safeNext(candidate) {
  if (typeof candidate !== "string" || !candidate.startsWith("/")) return "/";
  const base = "https://gate.invalid";
  try {
    const parsed = new URL(candidate, base);
    const decodedPath = decodeURIComponent(parsed.pathname);
    if (parsed.origin !== base || decodedPath === "/__gate" || decodedPath.startsWith("/__gate/")) return "/";
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return "/";
  }
}

/** ブラウザからのログイン CSRF を防ぐため、POST 元を gate 自身に限定する。 */
export function isSameOriginRequest(request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}
