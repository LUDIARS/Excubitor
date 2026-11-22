import { isDeepStrictEqual } from 'node:util';
import type { AccessAppConfig, TokenHeaderPlan } from '../access-token-header-service.js';

const FIELD = 'read_service_tokens_from_header';
const READ_ONLY = new Set(['id', 'uid', 'aud', 'created_at', 'updated_at']);

/** C-44: only read_service_tokens_from_header changes; every writable field of the current app is kept. */
export default {
  post(result: TokenHeaderPlan, current: AccessAppConfig, header: string | null) {
    const body = result.body;
    if (header === null ? FIELD in body : body[FIELD] !== header) return 'token header field not set to the requested value';
    for (const key of Object.keys(body)) if (READ_ONLY.has(key)) return `read-only field ${key} sent`;
    for (const [key, value] of Object.entries(current)) {
      if (key === FIELD || READ_ONLY.has(key)) continue;
      if (!(key in body)) return `field ${key} dropped`;
      if (key === 'policies') {
        const ids = (v: unknown) => (Array.isArray(v) ? v.map((p) => (p as { id?: unknown })?.id ?? p) : v);
        if (!isDeepStrictEqual(ids(body[key]), ids(value))) return 'policies changed';
        continue;
      }
      if (!isDeepStrictEqual(body[key], value)) return `field ${key} changed`;
    }
    return true;
  },
};
