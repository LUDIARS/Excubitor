import type { SecretAgentCaller } from './secret-agent-auth.js';

/** C-22: a service-scoped caller may resolve only its own service. */
export default {
  post: (result: boolean, caller: SecretAgentCaller, service: string) => {
    if (caller.kind === 'service') return result === (caller.service === service) || 'service token resolved another service';
    return result === true || 'legacy caller rejected while compatibility is on';
  },
};
