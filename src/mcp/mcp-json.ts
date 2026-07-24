/**
 * `<arsRoot>/.mcp.json` の excubitor エントリ整合。
 *
 * .mcp.json は Claude Code がワークスペース直下で読む MCP サーバ定義。 excubitor は
 * backend 直載せの Streamable HTTP (`http://127.0.0.1:<port>/mcp`) を指す。
 * 旧形式 (stdio: セッション毎に tsx + node プロセスが立ち ≈100MB × セッション数) からの
 * 移行も boot 時のこの整合で自動的に行われる。
 *
 * Excubitor が自分の MCP エントリの整合に責任を持ち、 boot 時に自分の port から
 * URL を導出して .mcp.json に反映する (他の MCP サーバ定義は保持)。
 * Concordia 等の他サービスに自分の接続先を書かせない (= 結合を作らない)。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createNamedLogger } from "../shared/logger.js";

const logger = createNamedLogger("excubitor.mcp-json");

/** stdio (command/args) と http (type/url) の両形式を受ける。 */
interface McpServerEntry {
  type?: string;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

interface McpJson {
  mcpServers?: Record<string, McpServerEntry>;
  [k: string]: unknown;
}

/** Excubitor backend の既定 listen port。 これ以外での起動は「非通常起動」扱い。 */
export const DEFAULT_BACKEND_PORT = 17332;

/** reconcile 実行可否の判定入力。 起動モードを表す純粋な値のみを受ける (テスト可能)。 */
export interface McpReconcileGate {
  /** SafeMode (EXCUBITOR_SAFE_MODE=1 / --safe) で起動しているか。 */
  safeMode: boolean;
  /** 今回起動した backend の listen port。 */
  port: number;
  /** 既定ポート (省略時は DEFAULT_BACKEND_PORT)。 */
  defaultPort?: number;
}

export interface McpReconcileDecision {
  /** true のときだけ共有 `.mcp.json` を reconcile してよい。 */
  reconcile: boolean;
  /** スキップ理由 (reconcile=true のときは null)。 ログに残す。 */
  skipReason: "safe_mode" | "non_default_port" | null;
}

/**
 * 共有 `.mcp.json` を reconcile してよいのは「通常起動」だけかを判定する。
 *
 * 通常起動 = SafeMode でなく、 かつ既定ポートで起動している場合。 scratch 起動・
 * 別ポート起動・SafeMode 起動は一時的/非常用の起動であり、 常用 Excubitor が使う
 * 正規の `.mcp.json` を「今回の (非常用) port」に書き換えて壊してはならないので
 * reconcile をスキップする。
 */
export function shouldReconcileMcpJson(gate: McpReconcileGate): McpReconcileDecision {
  const defaultPort = gate.defaultPort ?? DEFAULT_BACKEND_PORT;
  if (gate.safeMode) return { reconcile: false, skipReason: "safe_mode" };
  if (gate.port !== defaultPort) return { reconcile: false, skipReason: "non_default_port" };
  return { reconcile: true, skipReason: null };
}

/** backend port から excubitor MCP サーバの接続定義 (Streamable HTTP) を組み立てる。 */
export function excubitorMcpEntry(port: number): McpServerEntry {
  return {
    type: "http",
    url: `http://127.0.0.1:${port}/mcp`,
  };
}

export interface ReconcileResult {
  path: string;
  changed: boolean;
  reason: string;
}

/**
 * `<root>/.mcp.json` の `mcpServers.excubitor` を自分の port 由来の HTTP エントリに
 * 整合させる。 他サーバ定義は保持。 既存内容と一致していれば書き込まない (冪等)。
 * ファイルが壊れている場合は握りつぶさず warn し、 破壊を避けてスキップする。
 */
export function reconcileMcpJson(root: string, port: number): ReconcileResult {
  const path = join(root, ".mcp.json");

  let current: McpJson = {};
  if (existsSync(path)) {
    try {
      current = JSON.parse(readFileSync(path, "utf8")) as McpJson;
    } catch (err) {
      logger.warn({ path, err: (err as Error).message }, ".mcp.json parse 失敗 → 整合をスキップ (破壊回避)");
      return { path, changed: false, reason: "parse_error" };
    }
  }

  const servers = current.mcpServers ?? {};
  const desired = excubitorMcpEntry(port);

  if (JSON.stringify(servers.excubitor) === JSON.stringify(desired)) {
    return { path, changed: false, reason: "up_to_date" };
  }

  const next: McpJson = { ...current, mcpServers: { ...servers, excubitor: desired } };
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n", "utf8");
  logger.info({ path, url: desired.url }, ".mcp.json excubitor エントリを Streamable HTTP に整合");
  return { path, changed: true, reason: existsSync(path) ? "updated" : "created" };
}
