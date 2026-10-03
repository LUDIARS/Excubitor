import type { Service } from '../catalog/loader.js';

export default {
  post: (result: Record<string, string>, svc: Service) => {
    const required = new Set((svc.requires_secret ?? []).flatMap((r) => r.keys));
    return [...required].every((key) => Object.hasOwn(result, key) && result[key]!.trim() !== '')
      && Object.keys(result).every((key) => required.has(key))
      || 'required Vault keys must be complete and limited to the request';
  },
  postThrow: (error: unknown) => error instanceof Error || 'missing Vault keys must fail explicitly',
};
