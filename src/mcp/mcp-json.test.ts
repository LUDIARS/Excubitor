import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  excubitorMcpEntry,
  reconcileMcpJson,
  shouldReconcileMcpJson,
  DEFAULT_BACKEND_PORT,
} from "./mcp-json.js";

const tmpDirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "excubitor-mcp-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

describe("excubitorMcpEntry", () => {
  it("port から Streamable HTTP エントリを組む", () => {
    expect(excubitorMcpEntry(17332)).toEqual({
      type: "http",
      url: "http://127.0.0.1:17332/mcp",
    });
  });

  it("port 指定が反映される", () => {
    expect(excubitorMcpEntry(9999).url).toBe("http://127.0.0.1:9999/mcp");
  });
});

describe("shouldReconcileMcpJson", () => {
  it("通常起動 (SafeMode でない + 既定ポート) では reconcile する", () => {
    expect(shouldReconcileMcpJson({ safeMode: false, port: DEFAULT_BACKEND_PORT })).toEqual({
      reconcile: true,
      skipReason: null,
    });
  });

  it("SafeMode 起動では既定ポートでも reconcile をスキップする", () => {
    expect(shouldReconcileMcpJson({ safeMode: true, port: DEFAULT_BACKEND_PORT })).toEqual({
      reconcile: false,
      skipReason: "safe_mode",
    });
  });

  it("別ポート起動 (scratch/検証) では reconcile をスキップする", () => {
    expect(shouldReconcileMcpJson({ safeMode: false, port: 58156 })).toEqual({
      reconcile: false,
      skipReason: "non_default_port",
    });
  });

  it("SafeMode は別ポート判定より優先される", () => {
    expect(shouldReconcileMcpJson({ safeMode: true, port: 58156 })).toEqual({
      reconcile: false,
      skipReason: "safe_mode",
    });
  });

  it("defaultPort を明示指定して判定できる", () => {
    expect(shouldReconcileMcpJson({ safeMode: false, port: 9000, defaultPort: 9000 }).reconcile).toBe(true);
    expect(shouldReconcileMcpJson({ safeMode: false, port: 9000, defaultPort: 17332 }).skipReason).toBe(
      "non_default_port",
    );
  });
});

describe("reconcileMcpJson", () => {
  it("ファイルが無ければ excubitor エントリを作成する", () => {
    const root = freshDir();
    const r = reconcileMcpJson(root, 17332);
    expect(r.changed).toBe(true);
    const json = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
    expect(json.mcpServers.excubitor).toEqual({ type: "http", url: "http://127.0.0.1:17332/mcp" });
  });

  it("旧 stdio 形式 (command/args) から HTTP 形式へ移行する", () => {
    const root = freshDir();
    writeFileSync(
      join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          other: { command: "node", args: ["keep.js"] },
          excubitor: {
            command: "node",
            args: ["E:/Document/Ars/Excubitor/node_modules/tsx/dist/cli.mjs", "E:/Document/Ars/Excubitor/src/mcp/server.ts"],
            env: { EXCUBITOR_PORT: "${EXCUBITOR_PORT:-17332}" },
          },
        },
      }),
      "utf8",
    );
    const r = reconcileMcpJson(root, 17332);
    expect(r.changed).toBe(true);
    const json = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
    expect(json.mcpServers.other).toEqual({ command: "node", args: ["keep.js"] });
    expect(json.mcpServers.excubitor).toEqual({ type: "http", url: "http://127.0.0.1:17332/mcp" });
  });

  it("既に整合済みなら書き込まない (冪等)", () => {
    const root = freshDir();
    reconcileMcpJson(root, 17332);
    const second = reconcileMcpJson(root, 17332);
    expect(second.changed).toBe(false);
    expect(second.reason).toBe("up_to_date");
  });

  it("壊れた .mcp.json は握りつぶさず破壊回避でスキップする", () => {
    const root = freshDir();
    writeFileSync(join(root, ".mcp.json"), "{ not json", "utf8");
    const r = reconcileMcpJson(root, 17332);
    expect(r.changed).toBe(false);
    expect(r.reason).toBe("parse_error");
    // 破壊されず元の内容のまま
    expect(readFileSync(join(root, ".mcp.json"), "utf8")).toBe("{ not json");
    expect(existsSync(join(root, ".mcp.json"))).toBe(true);
  });
});
