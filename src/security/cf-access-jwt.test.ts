import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { accessJwtKeyId, createAccessKeySource, parseAccessJwtConfig, verifyAccessJwt } from './cf-access-jwt.js';
import { createAdminAccessVerifier } from './admin-access.js';

const config = { teamDomain: 'team.cloudflareaccess.com', audience: 'a'.repeat(64) };
const NOW = 1_800_000_000;
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });

function jwt(claims: Record<string, unknown>, key: KeyObject = privateKey, header: Record<string, unknown> = { alg: 'RS256', kid: 'k1' }): string {
  const encoded = [header, claims].map((part) => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.');
  return `${encoded}.${sign('RSA-SHA256', Buffer.from(encoded), key).toString('base64url')}`;
}
const good = { iss: `https://${config.teamDomain}`, aud: [config.audience], exp: NOW + 300, nbf: NOW - 10, email: 'admin@example.com' };

/** @implements SPEC-SECURITY-BROWSER-ALLOWLIST */
describe('Cloudflare Access JWT', () => {
  it('accepts a token signed by the team key for this AUD', () => {
    expect(verifyAccessJwt(jwt(good), config, publicKey, NOW)).toEqual({ ok: true, subject: 'admin@example.com' });
    expect(accessJwtKeyId(jwt(good))).toBe('k1');
  });

  it('rejects forged, foreign, expired and mis-addressed tokens', () => {
    expect(verifyAccessJwt(jwt(good, other.privateKey), config, publicKey, NOW)).toMatchObject({ ok: false, reason: 'bad_signature' });
    expect(verifyAccessJwt(jwt({ ...good, aud: ['b'.repeat(64)] }), config, publicKey, NOW)).toMatchObject({ ok: false, reason: 'bad_audience' });
    expect(verifyAccessJwt(jwt({ ...good, iss: 'https://evil.cloudflareaccess.com' }), config, publicKey, NOW)).toMatchObject({ ok: false, reason: 'bad_issuer' });
    expect(verifyAccessJwt(jwt({ ...good, exp: NOW - 3600 }), config, publicKey, NOW)).toMatchObject({ ok: false, reason: 'expired' });
    expect(verifyAccessJwt(jwt(good, privateKey, { alg: 'none', kid: 'k1' }), config, publicKey, NOW)).toMatchObject({ ok: false, reason: 'unsupported_alg' });
    expect(verifyAccessJwt(jwt(good), config, null, NOW)).toMatchObject({ ok: false, reason: 'unknown_key' });
    expect(verifyAccessJwt('not-a-jwt', config, publicKey, NOW)).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('reads only a well-formed runtime-config entry', () => {
    expect(parseAccessJwtConfig({ teamDomain: 'Team.cloudflareaccess.com', audience: 'A'.repeat(64) })).toEqual(config);
    expect(parseAccessJwtConfig({ teamDomain: 'evil.example.com', audience: 'a'.repeat(64) })).toBeNull();
    expect(parseAccessJwtConfig({ teamDomain: config.teamDomain, audience: 'short' })).toBeNull();
    expect(parseAccessJwtConfig(undefined)).toBeNull();
  });

  it('fetches the team certs once and verifies through the admin verifier', async () => {
    const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1' };
    const fetchImpl = vi.fn(async (_url: string) => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }));
    const keys = createAccessKeySource(config, fetchImpl as unknown as typeof fetch, () => NOW * 1000);
    const verifier = createAdminAccessVerifier(config, keys, () => NOW * 1000);
    expect(await verifier.verify(jwt(good))).toBe(true);
    expect(await verifier.verify(jwt(good))).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://team.cloudflareaccess.com/cdn-cgi/access/certs');
    // An unknown kid does not trigger another fetch within the refresh interval.
    expect(await verifier.verify(jwt(good, privateKey, { alg: 'RS256', kid: 'other' }))).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
