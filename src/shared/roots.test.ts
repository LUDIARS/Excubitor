import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { arsRoot, developRoot, domainRoot } from "./roots.js";
import { setDomainRootOverride } from "../secrets/config-store.js";

const ENV_KEYS = ["EXCUBITOR_ARS_ROOT", "EXCUBITOR_DEVELOP_ROOT", "LUDIARS_ROOT", "EXCUBITOR_DOMAIN_ROOT", "EXCUBITOR_CONFIG_PATH"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];
let tempConfigDir: string | null = null;

beforeEach(() => {
  tempConfigDir = mkdtempSync(join(tmpdir(), "excubitor-roots-"));
  process.env.EXCUBITOR_CONFIG_PATH = join(tempConfigDir, "config.enc");
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  if (tempConfigDir) rmSync(tempConfigDir, { recursive: true, force: true });
  tempConfigDir = null;
});

describe("arsRoot", () => {
  it("EXCUBITOR_ARS_ROOT を最優先で使う (forward-slash 正規化 + 末尾スラッシュ除去)", () => {
    delete process.env.LUDIARS_ROOT;
    process.env.EXCUBITOR_ARS_ROOT = "D:\\LUDIARS\\";
    expect(arsRoot()).toBe("D:/LUDIARS");
  });

  it("EXCUBITOR_ARS_ROOT が無ければ LUDIARS_ROOT にフォールバックする", () => {
    delete process.env.EXCUBITOR_ARS_ROOT;
    process.env.LUDIARS_ROOT = "E:/Document/Ars";
    expect(arsRoot()).toBe("E:/Document/Ars");
  });

  it("env 未設定なら cwd の親 (= <root>/Excubitor 前提) を返す", () => {
    delete process.env.EXCUBITOR_ARS_ROOT;
    delete process.env.LUDIARS_ROOT;
    const expected = dirname(resolve(process.cwd())).replace(/\\/g, "/");
    expect(arsRoot()).toBe(expected);
  });
});

describe("developRoot", () => {
  it("既定は <ARS_ROOT>/develop", () => {
    process.env.EXCUBITOR_ARS_ROOT = "D:\\LUDIARS\\";
    delete process.env.EXCUBITOR_DEVELOP_ROOT;
    expect(developRoot()).toBe("D:/LUDIARS/develop");
  });

  it("EXCUBITOR_DEVELOP_ROOT で上書きできる", () => {
    process.env.EXCUBITOR_DEVELOP_ROOT = "F:\\clones\\develop\\";
    expect(developRoot()).toBe("F:/clones/develop");
  });
});

describe("domainRoot saved config", () => {
  it("uses saved config when EXCUBITOR_DOMAIN_ROOT is not set", () => {
    delete process.env.EXCUBITOR_DOMAIN_ROOT;
    setDomainRootOverride("ai-run-do.com");
    expect(domainRoot()).toBe(".ai-run-do.com");
  });

  it("prefers EXCUBITOR_DOMAIN_ROOT over saved config", () => {
    setDomainRootOverride(".ai-run-do.com");
    process.env.EXCUBITOR_DOMAIN_ROOT = ".example.test";
    expect(domainRoot()).toBe(".example.test");
  });
});

describe("domainRoot", () => {
  it("既定は .melpot.dev", () => {
    delete process.env.EXCUBITOR_DOMAIN_ROOT;
    expect(domainRoot()).toBe("");
  });

  it("EXCUBITOR_DOMAIN_ROOT で上書きできる", () => {
    process.env.EXCUBITOR_DOMAIN_ROOT = ".example.test";
    expect(domainRoot()).toBe(".example.test");
  });
});
