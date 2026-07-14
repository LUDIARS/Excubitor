/**
 * 共有 Vestigium ログルートの単一解決点。
 *
 * LUDIARS 各サービスの Vestigium は `<root>/<code>/YYYY-MM-DD.jsonl` に書く規約
 * (DESIGN.md §2.2)。 その `<root>` を「全サービス共通の 1 箇所」に揃えることで、
 *   - spawn 時の env 注入 (process/inject.ts) — 全サービスに同じ root を渡す
 *   - file-tail (log/file-tail.ts) — root 配下の全 `<code>/` を自動発見して tail
 *   - LLM ログ横断読み (log/sse.ts)
 * が同じ場所を指す。
 *
 * 既定は Ars ワークスペース直下の `logs/` (= Excubitor の 1 つ上)。 catalog の
 * `log_path: E:/Document/Ars/logs/<code>` と一致する。 `VESTIGIUM_LOGS_DIR` で上書き可。
 */
import path from 'node:path';

export function sharedLogsRoot(): string {
  const env = process.env.VESTIGIUM_LOGS_DIR?.trim();
  if (env) return path.resolve(env);
  // Excubitor の cwd は E:/Document/Ars/Excubitor 前提。 その親の logs/ が共有ルート。
  return path.resolve(process.cwd(), '..', 'logs');
}
