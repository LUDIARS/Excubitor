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
