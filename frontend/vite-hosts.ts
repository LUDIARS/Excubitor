import { resolveAllowedHosts } from './config';

export function resolveViteAllowedHosts(): string[] {
  return Array.from(new Set(resolveAllowedHosts()));
}
