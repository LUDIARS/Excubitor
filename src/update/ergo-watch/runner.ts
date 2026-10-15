/**
 * `ergo_pkg watch` を 1 回起動する。 shell を通さず引数配列で渡し、 窓を出さない。
 *
 * @implements SPEC-ERGO-WATCH-DELIVERY
 */

import { execCapture } from '../../shared/exec.js';
import { redactValue } from './redact.js';

export interface WatchRunResult {
  ok: boolean;
  exitCode: number | null;
  /** 伏せ字済みの診断 (stderr の末尾)。 */
  diagnostic: string;
}

const DIAGNOSTIC_TAIL = 2_000;

export async function runErgoWatch(
  ergoPkg: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<WatchRunResult> {
  const result = await execCapture(ergoPkg, args, cwd, timeoutMs);
  return {
    ok: result.ok,
    exitCode: result.code,
    diagnostic: redactValue(result.stderr.trim().slice(-DIAGNOSTIC_TAIL)),
  };
}
