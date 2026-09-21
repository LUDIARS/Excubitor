/**
 * C-7 の述語モジュール (`augur.contracts.json`)。
 *
 * 保存は fail-closed: JSON object でない値・不正な service code は
 * `ServiceRuntimeConfigValidationError` で弾き、部分保存を残さない。
 */

import { isRuntimeConfigStatus } from './runtime-config-contract-shapes.js';

export default {
  post: (result: unknown) =>
    isRuntimeConfigStatus(result) || 'accepted runtime config must return a status object',
  postThrow: (error: unknown) =>
    (error instanceof Error && error.name === 'ServiceRuntimeConfigValidationError')
    || 'invalid runtime config must fail as ServiceRuntimeConfigValidationError',
};
