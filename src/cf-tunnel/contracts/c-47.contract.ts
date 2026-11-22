import type { TokenHeaderChangeInput, TokenHeaderChangeResult } from '../access-token-header-service.js';

/** C-47: nothing is written unless apply is true, and the response never carries an AUD. */
export default {
  post(result: TokenHeaderChangeResult, _api: unknown, _allowlist: unknown, input: TokenHeaderChangeInput) {
    if (input.apply !== true && result.applied) return 'written without apply';
    if (/"aud"\s*:/.test(JSON.stringify(result))) return 'response carries an AUD';
    return true;
  },
};
