/**
 * `<arsRoot>/.mcp.json` の excubitor エントリ整合。
 *
 * .mcp.json は Claude Code がワークスペース直下で読む MCP サーバ定義。 その中の
 * `excubitor` サーバは **Excubitor 自身の MCP** (`<root>/Excubitor/src/mcp/server.ts`)
 * を指すため、 パスが E:/Document/Ars 固定だと別ドライブのマシンで MCP が起動できない。
 *
 * Excubitor が自分の MCP サーバを指すエントリの整合に責任を持ち、 boot 時に
 * arsRoot() からパスを導出して .mcp.json に反映する (他の MCP サーバ定義は保持)。
 * Concordia 等の他サービスに自分のパスを書かせない (= 結合を作らない)。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createNamedLogger } from "../shared/logger.js";

const logger = createNamedLogger("excubitor.mcp-json");

const DEFAULT_PORT_ENV = "${EXCUBITOR_PORT:-17332}";

interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface McpJson {
  mcpServers?: Record<string, McpServerEntry>;
  [k: string]: unknown;
}

/** arsRoot から excubitor MCP サーバの起動定義を組み立てる (forward-slash 絶対パス)。 */
export function excubitorMcpEntry(root: string, existingEnv?: Record<string, string>): McpServerEntry {
  // root が OS ネイティブ表記 (backslash) でも混在しないよう forward-slash に正規化する。
  const base = root.replace(/\\/g, "/").replace(/\/+$/, "");
  return {
    command: "node",
    args: [
      `${base}/Excubitor/node_modules/tsx/dist/cli.mjs`,
      `${base}/Excubitor/src/mcp/server.ts`,
    ],
    env: existingEnv ?? { EXCUBITOR_PORT: DEFAULT_PORT_ENV },
  };
}

export interface ReconcileResult {
  path: string;
  changed: boolean;
  reason: string;
}

/**
 * `<root>/.mcp.json` の `mcpServers.excubitor` を arsRoot 由来のパスに整合させる。
 * 他サーバ定義は保持。 既存内容と一致していれば書き込まない (冪等)。
 * ファイルが壊れている場合は握りつぶさず warn し、 破壊を避けてスキップする。
 */
export function reconcileMcpJson(root: string): ReconcileResult {
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
  const desired = excubitorMcpEntry(root, servers.excubitor?.env);

  if (JSON.stringify(servers.excubitor) === JSON.stringify(desired)) {
    return { path, changed: false, reason: "up_to_date" };
  }

  const next: McpJson = { ...current, mcpServers: { ...servers, excubitor: desired } };
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n", "utf8");
  logger.info({ path, args: desired.args }, ".mcp.json excubitor エントリを arsRoot に整合");
  return { path, changed: true, reason: existsSync(path) ? "updated" : "created" };
}
