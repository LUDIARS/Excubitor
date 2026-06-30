import { describe, it, expect, afterEach } from "vitest";
import { dirname, resolve } from "node:path";
import { arsRoot, domainRoot } from "./roots.js";

const ENV_KEYS = ["EXCUBITOR_ARS_ROOT", "LUDIARS_ROOT", "EXCUBITOR_DOMAIN_ROOT"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
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

describe("domainRoot", () => {
  it("既定は .melpot.dev", () => {
    delete process.env.EXCUBITOR_DOMAIN_ROOT;
    expect(domainRoot()).toBe(".melpot.dev");
  });

  it("EXCUBITOR_DOMAIN_ROOT で上書きできる", () => {
    process.env.EXCUBITOR_DOMAIN_ROOT = ".example.test";
    expect(domainRoot()).toBe(".example.test");
  });
});
