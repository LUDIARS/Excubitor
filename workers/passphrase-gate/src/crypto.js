/** @implements SPEC-PASSPHRASE-GATE (spec/feature/passphrase-gate.md) */
// 署名・比較・エンコードの純粋関数。Workers と Node 20 の WebCrypto 両方で動く。

const encoder = new TextEncoder();

export function base64UrlEncode(bytes) {
  const bin = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(text) {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  const bin = atob(padded);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hmacSign(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64UrlEncode(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

/** 長さが違っても早期 return しない定数時間比較。 */
export function timingSafeEqual(a, b) {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** 入力の合言葉を設定値と比較する。設定は平文 (PASSPHRASE) か SHA-256 hex (PASSPHRASE_SHA256) のどちらか。 */
export async function verifyPassphrase(input, env) {
  assertPassphraseConfiguration(env);
  const normalized = String(input ?? "").normalize("NFKC").trim();
  if (env.PASSPHRASE_SHA256) {
    return timingSafeEqual(await sha256Hex(normalized), env.PASSPHRASE_SHA256.toLowerCase());
  }
  const configured = env.PASSPHRASE.normalize("NFKC").trim();
  const [inputDigest, configuredDigest] = await Promise.all([sha256Hex(normalized), sha256Hex(configured)]);
  return timingSafeEqual(inputDigest, configuredDigest);
}

/** 必須秘密の欠落や壊れた hash を認証失敗として隠さず、設定エラーにする。 */
export function assertPassphraseConfiguration(env) {
  const hash = env?.PASSPHRASE_SHA256;
  if (hash !== undefined && hash !== "") {
    if (typeof hash !== "string" || !/^[0-9a-f]{64}$/i.test(hash)) {
      throw new Error("PASSPHRASE_SHA256 must be a 64-character hexadecimal SHA-256 digest");
    }
    return;
  }
  if (typeof env?.PASSPHRASE !== "string" || env.PASSPHRASE.normalize("NFKC").trim() === "") {
    throw new Error("PASSPHRASE or PASSPHRASE_SHA256 must be configured");
  }
}

export function randomId(bytes = 12) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64UrlEncode(buf);
}
