import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config, resolveAllowedHosts } from './config';

export function resolveViteAllowedHosts(): string[] {
  return Array.from(new Set([...resolveAllowedHosts(), ...catalogHosts()]));
}

function catalogHosts(): string[] {
  const path = resolve(process.cwd(), '../catalog/services.yaml');
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');
  const hosts = new Set<string>();
  for (const m of raw.matchAll(/^\s+(?:frontend_url|domain):\s*(\S+)/gm)) {
    const host = hostFromValue(stripQuotes(m[1] ?? ''));
    if (host) hosts.add(host);
  }
  for (const m of raw.matchAll(/^\s+subdomain:\s*([a-zA-Z0-9-]+)/gm)) {
    for (const root of envDomainRoots()) hosts.add(`${m[1]}.${root}`);
  }
  const staticHosts = new Set<string>(config.allowedHosts);
  return Array.from(hosts).filter((host) => !staticHosts.has(host));
}

function envDomainRoots(): string[] {
  return (process.env.EXCUBITOR_DOMAIN_ROOT ?? process.env.LUDIARS_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim().replace(/^\*\./, '').replace(/^\./, ''))
    .filter(Boolean);
}

function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, '');
}

function hostFromValue(value: string): string | null {
  if (!value || value.includes('${')) return null;
  try {
    return new URL(value.includes('://') ? value : `https://${value}`).hostname;
  } catch {
    return null;
  }
}
