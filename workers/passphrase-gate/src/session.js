/** @implements SPEC-PASSPHRASE-GATE (spec/feature/passphrase-gate.md) */
// 署名付き Cookie によるセッション。payload.sig 形式、HMAC-SHA256。

import { base64UrlDecode, base64UrlEncode, hmacSign, timingSafeEqual } from "./crypto.js";

export const COOKIE_NAME = "pg_session";
const DEFAULT_TTL_SECONDS = 12 * 60 * 60;
const MIN_COOKIE_SECRET_BYTES = 32;

export function sessionTtlSeconds(env) {
  if (env?.SESSION_TTL_SECONDS === undefined || env.SESSION_TTL_SECONDS === "") return DEFAULT_TTL_SECONDS;
  const n = Number(env.SESSION_TTL_SECONDS);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error("SESSION_TTL_SECONDS must be a positive integer");
  }
  return n;
}

export function assertSessionConfiguration(env) {
  if (typeof env?.COOKIE_SECRET !== "string" || new TextEncoder().encode(env.COOKIE_SECRET).length < MIN_COOKIE_SECRET_BYTES) {
    throw new Error(`COOKIE_SECRET must contain at least ${MIN_COOKIE_SECRET_BYTES} bytes`);
  }
  sessionTtlSeconds(env);
}

export async function createSessionCookie(env, visitor, now = Date.now()) {
  assertSessionConfiguration(env);
  const issuedAt = Math.floor(now / 1000);
  const payload = {
    id: visitor.id,
    name: visitor.name,
    iat: issuedAt,
    exp: issuedAt + sessionTtlSeconds(env),
  };
  const body = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await hmacSign(env.COOKIE_SECRET, body);
  return `${body}.${sig}`;
}

/** 有効なら payload を、無効・期限切れ・改竄なら null を返す。 */
export async function verifySessionCookie(env, value, now = Date.now()) {
  assertSessionConfiguration(env);
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  const expected = await hmacSign(env.COOKIE_SECRET, body);
  if (!timingSafeEqual(sig, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(body)));
  } catch {
    return null;
  }
  const nowSeconds = Math.floor(now / 1000);
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    typeof payload.id !== "string" ||
    payload.id.length === 0 ||
    payload.id.length > 128 ||
    typeof payload.name !== "string" ||
    payload.name.trim().length === 0 ||
    [...payload.name].length > 40 ||
    new TextDecoder().decode(new TextEncoder().encode(payload.name)) !== payload.name ||
    !Number.isSafeInteger(payload.iat) ||
    !Number.isSafeInteger(payload.exp) ||
    payload.iat < 0 ||
    payload.iat > nowSeconds ||
    payload.exp <= nowSeconds ||
    payload.exp <= payload.iat ||
    payload.exp - payload.iat > sessionTtlSeconds(env)
  ) {
    return null;
  }
  return payload;
}

export function readCookie(request, name = COOKIE_NAME) {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

export function setCookieHeader(env, value) {
  return `${COOKIE_NAME}=${value}; Path=/; Max-Age=${sessionTtlSeconds(env)}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearCookieHeader() {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}
