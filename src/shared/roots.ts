/**
 * ワークスペース / ドメインのルート解決 — 単一解決点。
 *
 * これまで E:/Document/Ars がコード/カタログ各所にハードコードされ、 別ドライブ
 * (例 D:/LUDIARS) のマシンで全パスが壊れていた。 ルートを 1 箇所に集約し、
 *   - catalog (services.yaml) の `${ARS_ROOT}` / `${DOMAIN_ROOT}` 補間 (catalog/loader.ts)
 *   - 新規サービス検出の走査対象 (discovery/scan.ts)
 *   - レビュー JSON の探索ルート (reviews/router.ts)
 *   - 自分の MCP サーバを指す .mcp.json の整合 (mcp/mcp-json.ts)
 * が同じ値を指すようにする。 値はマシン依存なので env / 既定 (cwd の親) で解決し、
 * catalog 等にはドライブを焼き込まない。
 */

import { dirname, join, resolve } from "node:path";
import { DEFAULT_DOMAIN_ROOT, getDomainRootOverride, normalizeDomainRoot } from "../secrets/config-store.js";

/** 末尾スラッシュを除去し、 forward-slash に正規化する (catalog の path 表記と揃える)。 */
function normalizeRoot(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * Ars ワークスペース (ローカルクローンの親ディレクトリ) のルート。
 *
 * 解決順:
 *  1. env `EXCUBITOR_ARS_ROOT` (明示指定、 最優先)
 *  2. env `LUDIARS_ROOT` (旧 reviews 互換)
 *  3. Excubitor リポの親 (cwd=`<root>/Excubitor` 前提のマシン非依存な既定)
 *
 * forward-slash 正規化済みの絶対パスを返す。
 */
export function arsRoot(): string {
  const env = (process.env.EXCUBITOR_ARS_ROOT ?? process.env.LUDIARS_ROOT ?? "").trim();
  const base = env || dirname(resolve(process.cwd()));
  return normalizeRoot(base);
}

/**
 * develop 系クローンの親ディレクトリ。
 * env 未指定時は `<ARS_ROOT>/develop` を使う。
 */
export function developRoot(): string {
  const env = (process.env.EXCUBITOR_DEVELOP_ROOT ?? "").trim();
  return normalizeRoot(env || join(arsRoot(), "develop"));
}

/**
 * 全サービス共通のドメインルート (Vite dev server の allowedHosts 等)。
 * env `EXCUBITOR_DOMAIN_ROOT` で上書き、 未設定なら `.melpot.dev`。
 */
export function domainRoot(): string {
  const env = (process.env.EXCUBITOR_DOMAIN_ROOT ?? "").trim();
  if (env) return normalizeDomainRoot(env);
  return getDomainRootOverride() ?? DEFAULT_DOMAIN_ROOT;
}
