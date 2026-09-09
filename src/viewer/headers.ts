import type { ViewerTarget } from './catalog.js';
import { viewerUrl } from './urls.js';

const HOP_HEADERS = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade'];

function stripHopHeaders(headers: Headers): void {
  const named = (headers.get('connection') ?? '').split(',').map((name) => name.trim()).filter(Boolean);
  for (const name of [...HOP_HEADERS, ...named]) headers.delete(name);
}

const cookiePrefix = (code: string): string => `exv_${code}.`;

export function upstreamHeaders(incoming: Headers, target: ViewerTarget): Headers {
  const headers = new Headers(incoming);
  stripHopHeaders(headers);
  for (const key of [...headers.keys()]) {
    if (/^(authorization$|host$|forwarded$|x-forwarded-|cf-|x-excubitor-|x-real-ip$)/i.test(key)) headers.delete(key);
  }
  // Never leak Ex or another service's cookies to a proxied application.
  const prefix = cookiePrefix(target.code);
  const cookies = (incoming.get('cookie') ?? '').split(';').map((part) => part.trim())
    .filter((part) => part.startsWith(prefix)).map((part) => {
      const split = part.indexOf('=');
      if (split < 0) return '';
      try {
        const name = Buffer.from(part.slice(prefix.length, split), 'base64url').toString('utf8');
        return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) ? `${name}${part.slice(split)}` : '';
      }
      catch { return ''; }
    }).filter(Boolean);
  headers.delete('cookie');
  if (cookies.length) headers.set('cookie', cookies.join('; '));
  headers.set('accept-encoding', 'identity');
  headers.set('x-forwarded-prefix', target.prefix);
  // Origin is deliberately preserved: a remote caller must never gain the
  // privileges of a loopback Origin merely because Ex is the transport.
  return headers;
}

export function viewerHeaders(incoming: Headers, target: ViewerTarget): Headers {
  const headers = new Headers(incoming);
  stripHopHeaders(headers);
  headers.delete('set-cookie');
  for (const cookie of incoming.getSetCookie()) {
    const parts = cookie.split(';');
    const first = parts.shift() ?? '';
    const split = first.indexOf('=');
    if (split < 1) continue;
    const name = Buffer.from(first.slice(0, split).trim(), 'utf8').toString('base64url');
    const originalPath = parts.find((part) => /^\s*path\s*=/i.test(part))?.split('=').slice(1).join('=').trim();
    const path = originalPath?.startsWith('/') ? originalPath : '/';
    const attributes = parts.filter((part) => !/^\s*(domain|path)\s*=/i.test(part));
    headers.append('set-cookie', `${cookiePrefix(target.code)}${name}${first.slice(split)}; Path=${target.prefix}${path};${attributes.join(';')}`);
  }
  const location = headers.get('location');
  if (location) headers.set('location', viewerUrl(location, target));
  // Proxied responses must never install an origin-wide worker or origin policy.
  headers.delete('service-worker-allowed');
  headers.delete('clear-site-data');
  headers.delete('alt-svc');
  headers.set('cache-control', 'no-store');
  return headers;
}
