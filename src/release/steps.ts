/**
 * component の build 手順 (シェルコマンド文字列の列) を順に実行する。
 * runner は注入できる (テストでは fake を渡して npm を実際に叩かない)。
 */

import { execCapture, type ExecResult } from '../shared/exec.js';

/** 1 コマンド文字列を cwd で実行する。 既定は shell 経由 (npm 等の .cmd 解決のため)。 */
export type StepRunner = (cmd: string, cwd: string) => Promise<ExecResult>;

/** 既定 runner: コマンド文字列をそのまま shell で実行 (timeout 10 分)。 */
export const defaultStepRunner: StepRunner = (cmd, cwd) =>
  execCapture(cmd, [], cwd, 600000, true);

export interface StepResult {
  cmd: string;
  ok: boolean;
  code: number | null;
  /** 失敗時のみ末尾を残す (成功時は空)。 */
  stderr: string;
}

/** 手順を順に実行。 1 つでも失敗したらそこで止める (後続は実行しない)。 */
export async function runBuildSteps(
  steps: string[],
  cwd: string,
  run: StepRunner,
): Promise<StepResult[]> {
  const out: StepResult[] = [];
  for (const cmd of steps) {
    const r = await run(cmd, cwd);
    out.push({ cmd, ok: r.ok, code: r.code, stderr: r.ok ? '' : r.stderr.slice(-2000) });
    if (!r.ok) break;
  }
  return out;
}
