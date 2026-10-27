import { isIPv4 } from 'node:net';

const explicitHttpOrigin = /^http:\/\/([^/:?#]+):([0-9]{1,5})\/?$/i;

/** Returns the explicitly written port after validating the complete private origin. */
export function privateHttpOriginPort(value: string): number | null {
  const match = explicitHttpOrigin.exec(value);
  if (!match) return null;
  const host = match[1]!;
  const port = Number(match[2]);
  if (!isIPv4(host) || port < 1 || port > 65535) return null;
  const [a = 0, b = 0] = host.split('.').map(Number);
  if (a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return port;
  return null;
}

/** Only explicitly configured private IPv4 endpoints; never request-derived DNS. */
export function isPrivateHttpOrigin(value: string): boolean {
  return privateHttpOriginPort(value) !== null;
}
