import { z } from 'zod';

/**
 * Route-scoped foreign-country exemption (SPEC-EX-INTRUSION-FOREIGN-PATHS).
 * A prefix is a literal, already-decoded path: no wildcard, query, percent escape,
 * dot segment, empty segment or trailing slash, and never the whole site ("/").
 */
const PREFIX = /^(?:\/[A-Za-z0-9._~!$&'()+,;=:@-]+)+$/;
export const foreignCountryPathsSchema = z.array(z.string().min(2).max(256)
  .regex(PREFIX, 'foreign-country path must be a literal "/" prefix')
  .refine(prefix => !prefix.split('/').some(segment => segment === '.' || segment === '..'), 'dot segments are not allowed'))
  .min(1).max(16);

/** RFC 7230 token, lower-case. Headers every client sends (or Cloudflare adds) are not credentials. */
const HEADER = /^[!#$%&'*+.^_`|~0-9a-z-]{1,64}$/;
const NOT_A_CREDENTIAL = /^(?:host|cf-.*|x-forwarded-.*|forwarded|user-agent|accept(?:-.*)?|connection|content-.*|cookie|origin|referer|upgrade)$/;
export const foreignCountryRequiredHeadersSchema = z.array(z.string().regex(HEADER, 'header name must be a lower-case token')
  .refine(name => !NOT_A_CREDENTIAL.test(name), 'header is sent by every client'))
  .min(1).max(4);

/** Presence only: true when any named header carries a non-blank value. The value is never returned. */
export function hasRequiredHeader(names: readonly string[] | undefined, headers: Readonly<Record<string, string | string[] | undefined>>): boolean {
  return !!names?.some(name => {
    const value = headers[name];
    return Array.isArray(value) ? value.some(v => v.trim() !== '') : typeof value === 'string' && value.trim() !== '';
  });
}

/** Same decoding as the exploit-path check: up to three passes; null when malformed. */
export function decodeRequestPath(path: string): string | null {
  try {
    let decoded = decodeURIComponent(path);
    for (let i = 0; i < 2 && /%[0-9a-f]{2}/i.test(decoded); i++) decoded = decodeURIComponent(decoded);
    return decoded;
  } catch { return null; }
}

/** Segment-boundary prefix match: "/v1/instructions" covers "/v1/instructions/x", not "/v1/instructionsX". */
export function isForeignCountryExempt(prefixes: readonly string[] | undefined, decodedPath: string): boolean {
  return !!prefixes?.some(prefix => decodedPath === prefix || decodedPath.startsWith(prefix + '/'));
}
