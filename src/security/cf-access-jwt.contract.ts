import type { AccessJwtConfig, AccessJwtResult } from './cf-access-jwt.js';

/** C-24: an accepted Access JWT is RS256, for this team and AUD, and unexpired. */
export default {
  post: (result: AccessJwtResult, token: string, config: AccessJwtConfig, _key: unknown, nowSec: number) => {
    if (!result.ok) return true;
    const [header, claims] = token.split('.').slice(0, 2).map((part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>);
    const aud = Array.isArray(claims?.aud) ? claims.aud : [claims?.aud];
    return (header?.alg === 'RS256' && claims?.iss === `https://${config.teamDomain}`
      && aud.some((value) => typeof value === 'string' && value.toLowerCase() === config.audience)
      && typeof claims?.exp === 'number' && claims.exp + 60 >= nowSec) || 'Access JWT accepted outside its team, AUD or lifetime';
  },
};
