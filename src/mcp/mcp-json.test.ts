import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { excubitorMcpEntry, reconcileMcpJson } from "./mcp-json.js";

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
  it("arsRoot 由来の forward-slash 絶対パスで args を組む", () => {
    const e = excubitorMcpEntry("D:/LUDIARS");
    expect(e.command).toBe("node");
    expect(e.args).toEqual([
      "D:/LUDIARS/Excubitor/node_modules/tsx/dist/cli.mjs",
      "D:/LUDIARS/Excubitor/src/mcp/server.ts",
    ]);
    expect(e.env).toEqual({ EXCUBITOR_PORT: "${EXCUBITOR_PORT:-17332}" });
  });

  it("既存 env を保持する", () => {
    const e = excubitorMcpEntry("D:/LUDIARS", { EXCUBITOR_PORT: "9999", FOO: "bar" });
    expect(e.env).toEqual({ EXCUBITOR_PORT: "9999", FOO: "bar" });
  });
});

describe("reconcileMcpJson", () => {
  it("ファイルが無ければ excubitor エントリを作成する", () => {
    const root = freshDir();
    const r = reconcileMcpJson(root);
    expect(r.changed).toBe(true);
    const json = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
    expect(json.mcpServers.excubitor.args[1]).toBe(`${root.replace(/\\/g, "/")}/Excubitor/src/mcp/server.ts`);
  });

  it("既存の他サーバ定義を保持しつつ excubitor のパスだけ整合する", () => {
    const root = freshDir();
    writeFileSync(
      join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          other: { command: "node", args: ["keep.js"] },
          excubitor: { command: "node", args: ["E:/Document/Ars/Excubitor/src/mcp/server.ts"], env: { EXCUBITOR_PORT: "${EXCUBITOR_PORT:-17332}" } },
        },
      }),
      "utf8",
    );
    const r = reconcileMcpJson(root);
    expect(r.changed).toBe(true);
    const json = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
    expect(json.mcpServers.other).toEqual({ command: "node", args: ["keep.js"] });
    expect(json.mcpServers.excubitor.args[0]).toContain(`${root.replace(/\\/g, "/")}/Excubitor`);
  });

  it("既に整合済みなら書き込まない (冪等)", () => {
    const root = freshDir();
    reconcileMcpJson(root);
    const second = reconcileMcpJson(root);
    expect(second.changed).toBe(false);
    expect(second.reason).toBe("up_to_date");
  });

  it("壊れた .mcp.json は握りつぶさず破壊回避でスキップする", () => {
    const root = freshDir();
    writeFileSync(join(root, ".mcp.json"), "{ not json", "utf8");
    const r = reconcileMcpJson(root);
    expect(r.changed).toBe(false);
    expect(r.reason).toBe("parse_error");
    // 破壊されず元の内容のまま
    expect(readFileSync(join(root, ".mcp.json"), "utf8")).toBe("{ not json");
    expect(existsSync(join(root, ".mcp.json"))).toBe(true);
  });
});
