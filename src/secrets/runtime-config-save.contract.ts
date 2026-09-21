/**
 * C-6 の述語モジュール (`augur.contracts.json`)。
 *
 * 保存 API は「設定されているか」と「トップレベルのキー名」だけを返し、値本文・保存先
 * パスを返さない。 これを実行時にも観測できるようにする。
 */

import { isRuntimeConfigStatus, isServiceCode } from './runtime-config-contract-shapes.js';

export default {
  pre: (code: unknown) => isServiceCode(code) || 'service code must be lowercase alphanumeric with hyphens',
  post: (result: unknown) =>
    isRuntimeConfigStatus(result) || 'runtime config status must expose only configured and keys',
};
