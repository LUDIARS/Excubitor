/**
 * Ex backend の readiness 待ちで「待つ / 1 回延長する / 諦める」を決める純関数。
 *
 * CPU 高負荷では backend の listen が readiness timeout を超えることがある (2026-09-26 実測
 * 26〜35 秒)。プロセスが生きている限り、timeout 到達時に同じ長さの猶予を 1 回だけ与える。
 *
 * @implements SPEC-EX-BACKEND-READINESS
 */

export type ReadinessDecision = 'wait' | 'extend' | 'exited' | 'timeout';

export interface ReadinessDecisionInput {
  /** readiness 待ちを始めてからの経過 ms。 */
  elapsedMs: number;
  /** 解決済みの readiness timeout (1 区間の長さ)。 */
  timeoutMs: number;
  /** spawn した backend プロセスがまだ exit していないか。 */
  processAlive: boolean;
  /** すでに延長を 1 回与えたか。 */
  extended: boolean;
}

export function readinessDecision(input: ReadinessDecisionInput): ReadinessDecision {
  if (!input.processAlive) return 'exited';
  const deadlineMs = input.extended ? input.timeoutMs * 2 : input.timeoutMs;
  if (input.elapsedMs < deadlineMs) return 'wait';
  return input.extended ? 'timeout' : 'extend';
}
