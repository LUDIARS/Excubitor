/**
 * C-10 の述語モジュール (`augur.contracts.json`)。
 *
 * 解決結果は常に有効範囲内の整数で、既定 source のときは既定値そのものになる。
 * 範囲の数値はここで再定義し、判定対象の実装から独立させる。
 */

const MIN_MS = 10_000;
const MAX_MS = 600_000;
const DEFAULT_MS = 90_000;
const SOURCES = new Set(['env', 'config', 'default']);

interface ResolutionShape {
  value?: unknown;
  source?: unknown;
  ignored?: unknown;
}

export default {
  post: (result: ResolutionShape) => {
    if (typeof result?.value !== 'number' || !Number.isInteger(result.value)) return 'value must be an integer';
    if (result.value < MIN_MS || result.value > MAX_MS) return 'value must stay within 10000..600000 ms';
    if (typeof result.source !== 'string' || !SOURCES.has(result.source)) return 'source must be env, config or default';
    if (result.source === 'default' && result.value !== DEFAULT_MS) return 'default source must resolve to 90000 ms';
    if (!Array.isArray(result.ignored)) return 'ignored must list rejected sources';
    return true;
  },
};
