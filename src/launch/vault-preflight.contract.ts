import type { PreflightReport } from './preflight.js';

export default {
  post: (result: PreflightReport) => result.needsIdentity === false
    && result.ok === result.services.every((svc) => svc.ready)
    && result.services.every((svc) => svc.ready === !svc.checks.some((check) => check.status === 'fail'))
    || 'Vault preflight must propagate failures without requiring Infisical identity',
};
