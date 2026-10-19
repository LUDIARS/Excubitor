import { createPublicKey } from 'node:crypto';

export default {
  post: (result: { sub: string; aud: string; kind: string; iat: string; exp: string; cnf: { public_key: string } }, input: { subject: string; audience: string; now: number }) =>
    (result.kind === 'workload' && result.sub === input.subject && result.aud === input.audience &&
      result.sub.includes('/') && result.aud.includes('/') && Date.parse(result.exp) > input.now && Date.parse(result.iat) <= input.now &&
      createPublicKey(result.cnf.public_key).asymmetricKeyType === 'ed25519' &&
      Date.parse(result.exp) > Date.parse(result.iat) &&
      Date.parse(result.exp) - Date.parse(result.iat) <= 60_000) || 'workload identity or lifetime invalid',
};
