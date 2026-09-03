import { test } from "node:test";
import assert from "node:assert/strict";

import { base64UrlEncode, hmacSign, sha256Hex, timingSafeEqual, verifyPassphrase } from "../src/crypto.js";
import { createSessionCookie, sessionTtlSeconds, verifySessionCookie } from "../src/session.js";
import { stripGateCookie } from "../src/proxy.js";
import { isSameOriginRequest, safeNext } from "../src/index.js";
import { htmlResponse } from "../src/pages.js";

const env = { COOKIE_SECRET: "test-secret-0123456789abcdef-0000", SESSION_TTL_SECONDS: "60" };

test("passphrase: 平文設定と NFKC 正規化", async () => {
  assert.equal(await verifyPassphrase("ひらけごま", { PASSPHRASE: "ひらけごま" }), true);
  assert.equal(await verifyPassphrase(" ﾋﾗｹｺﾞﾏ ", { PASSPHRASE: "ヒラケゴマ" }), true);
  assert.equal(await verifyPassphrase("ちがう", { PASSPHRASE: "ひらけごま" }), false);
  await assert.rejects(() => verifyPassphrase("anything", {}), /must be configured/);
});

test("passphrase: SHA-256 設定が平文より優先", async () => {
  const hash = await sha256Hex("open-sesame");
  assert.equal(await verifyPassphrase("open-sesame", { PASSPHRASE_SHA256: hash, PASSPHRASE: "other" }), true);
  assert.equal(await verifyPassphrase("other", { PASSPHRASE_SHA256: hash, PASSPHRASE: "other" }), false);
});

test("timingSafeEqual は長さ違いでも false", () => {
  assert.equal(timingSafeEqual("abc", "abc"), true);
  assert.equal(timingSafeEqual("abc", "abcd"), false);
  assert.equal(timingSafeEqual("", ""), true);
});

test("session cookie: 往復と改竄検知と期限", async () => {
  const visitor = { id: "v1", name: `${"a".repeat(39)}😀` };
  const cookie = await createSessionCookie(env, visitor, 1_000_000);
  const ok = await verifySessionCookie(env, cookie, 1_000_000 + 30_000);
  assert.equal(ok.name, visitor.name);

  assert.equal(await verifySessionCookie(env, cookie, 1_000_000 + 61_000), null, "期限切れ");
  assert.equal(await verifySessionCookie(env, cookie.slice(0, -2) + "zz", 1_000_000), null, "署名改竄");
  assert.equal(await verifySessionCookie({ ...env, COOKIE_SECRET: "other-secret-0123456789abcdef-0000" }, cookie, 1_000_000), null, "鍵違い");
  assert.equal(await verifySessionCookie(env, "garbage", 1_000_000), null);
});

test("session cookie: 設定と payload の型を検証する", async () => {
  await assert.rejects(() => createSessionCookie({ ...env, COOKIE_SECRET: "short" }, { id: "v1", name: "太郎" }), /at least 32 bytes/);
  assert.throws(() => sessionTtlSeconds({ SESSION_TTL_SECONDS: "1.5" }), /positive integer/);

  const body = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ id: "v1", name: 123, iat: 1_000, exp: 1_060 })));
  const malformed = `${body}.${await hmacSign(env.COOKIE_SECRET, body)}`;
  assert.equal(await verifySessionCookie(env, malformed, 1_000_000), null, "署名が正しくても payload 型が不正なら拒否");
});

test("safeNext は同一オリジンのパスだけ通す", () => {
  assert.equal(safeNext("/docs/x?y=1"), "/docs/x?y=1");
  assert.equal(safeNext("//evil.example"), "/");
  assert.equal(safeNext("https://evil.example/"), "/");
  assert.equal(safeNext("/\\evil.example/"), "/");
  assert.equal(safeNext("/%5f%5fgate/login"), "/");
  assert.equal(safeNext("/__gate/register"), "/");
  assert.equal(safeNext(undefined), "/");
});

test("login POST は同一オリジンだけを許す", () => {
  assert.equal(isSameOriginRequest(new Request("https://gate.example/__gate/login", { headers: { origin: "https://gate.example" } })), true);
  assert.equal(isSameOriginRequest(new Request("https://gate.example/__gate/login", { headers: { origin: "https://evil.example" } })), false);
  assert.equal(isSameOriginRequest(new Request("https://gate.example/__gate/login")), false);
});

test("入場画面はブラウザ向け防御ヘッダーを返す", () => {
  const response = htmlResponse("<p>gate</p>", 401);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-security-policy"), /form-action 'self'/);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
});

test("stripGateCookie はゲート Cookie だけ落とす", () => {
  assert.equal(stripGateCookie("pg_session=abc; theme=dark"), "theme=dark");
  assert.equal(stripGateCookie("pg_session=abc"), null);
  assert.equal(stripGateCookie(null), null);
});
