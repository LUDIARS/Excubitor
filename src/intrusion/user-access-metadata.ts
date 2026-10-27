import type { IncomingHttpHeaders } from 'node:http';

export interface UserAccessMetadata {
  cf_ray: string | null;
  user_agent: string;
  accept_language: string;
}

/** @spec spec/feature/user-access-log.md#metadata */
export function userAccessMetadata(headers: IncomingHttpHeaders): UserAccessMetadata {
  const text = (name: string, limit: number): string => {
    const value = headers[name];
    return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, limit) : '';
  };
  const ray = text('cf-ray', 64);
  return { cf_ray: /^[a-f0-9]{16,32}-[A-Z]{3}$/i.test(ray) ? ray : null,
    user_agent: text('user-agent', 1024), accept_language: text('accept-language', 256) };
}
