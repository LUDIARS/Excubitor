/**
 * C-5 の述語モジュール (`augur.contracts.json`)。
 *
 * 述語は純粋で、理由文字列に値そのものを載せない (Vestigium の機微情報ルールを継承)。
 * `@ludiars/log-weaver` は Excubitor の依存ではないため `Contract<...>` 型は参照せず、
 * 注入を外しても残るリポ資産としてユニットテストから直接呼べる形にしてある。
 */

import { isPlainJsonObject, isServiceCode } from './runtime-config-contract-shapes.js';

export default {
  pre: (code: unknown) => isServiceCode(code) || 'service code must be lowercase alphanumeric with hyphens',
  post: (result: unknown) =>
    result === null || isPlainJsonObject(result) || 'runtime config must resolve to null or a JSON object',
};
