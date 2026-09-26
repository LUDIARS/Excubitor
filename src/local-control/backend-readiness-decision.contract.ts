/**
 * C-9 の述語モジュール (`augur.contracts.json`)。
 *
 * 述語は純粋で、理由文字列に観測値を載せない。`@ludiars/log-weaver` は Excubitor の依存ではない
 * ため `Contract<...>` 型は参照せず、ユニットテストから直接呼べる形にしてある。
 */

const DECISIONS = new Set(['wait', 'extend', 'exited', 'timeout']);

interface DecisionInputShape {
  elapsedMs?: unknown;
  timeoutMs?: unknown;
  processAlive?: unknown;
  extended?: unknown;
}

export default {
  pre: (input: DecisionInputShape) => {
    if (typeof input?.elapsedMs !== 'number' || !Number.isFinite(input.elapsedMs) || input.elapsedMs < 0) {
      return 'elapsedMs must be a non-negative finite number';
    }
    if (typeof input.timeoutMs !== 'number' || !Number.isInteger(input.timeoutMs) || input.timeoutMs <= 0) {
      return 'timeoutMs must be a positive integer';
    }
    if (typeof input.processAlive !== 'boolean' || typeof input.extended !== 'boolean') {
      return 'processAlive and extended must be booleans';
    }
    return true;
  },
  post: (result: unknown) =>
    (typeof result === 'string' && DECISIONS.has(result)) || 'decision must be wait, extend, exited or timeout',
};
