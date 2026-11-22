import type { CfAccessApp } from '../cloudflare-access-api.js';

/** C-45: the selected app is the only self-hosted app whose domain equals the hostname. */
export default {
  post(result: CfAccessApp, apps: CfAccessApp[], hostname: string) {
    const host = hostname.trim().toLowerCase();
    const matches = apps.filter((a) => a.domain.trim().toLowerCase() === host && a.type === 'self_hosted');
    return (matches.length === 1 && matches[0] === result) || 'selected app is not the unique exact self-hosted match';
  },
};
