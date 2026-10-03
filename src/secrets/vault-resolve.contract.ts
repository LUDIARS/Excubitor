import type { ResolveResult } from './resolve.js';

export default {
  post: (result: ResolveResult, _code: string, _mapping: unknown, keys?: string[]) => {
    if (!result.ok) return ['no_mapping', 'keys_not_bound', 'fetch_failed'].includes(result.code);
    return result.projectId === null && result.environment === null
      && Object.values(result.secrets).every((value) => typeof value === 'string')
      && (!keys?.length || Object.keys(result.secrets).every((key) => keys.includes(key)))
      || 'Vault results must use explicit Vault metadata and requested keys only';
  },
};
