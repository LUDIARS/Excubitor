import type { IntrusionConfig } from './config.js';
import type { AccessEvidence, DetectionReason } from './detection.js';

export interface AccessDecision {
  source: 'gateway' | 'upstream';
  action: 'allow' | 'deny' | 'observe';
  reason: DetectionReason | 'none' | 'foreign_country_exempt' | 'temporary_limit' | 'not_found_burst';
}

/** Reason for a forwarded request: a non-allowed country can only have passed via a route path exemption. */
export function forwardedReason(config: Pick<IntrusionConfig, 'allowedCountries'>, event: AccessEvidence): 'none' | 'foreign_country_exempt' {
  return config.allowedCountries.includes(event.country) ? 'none' : 'foreign_country_exempt';
}

/** Categorize without persisting arbitrary path segments (which may contain credentials). */
export function safeRouteCategory(event: AccessEvidence): string {
  if (/\.(?:css|js|png|jpg|jpeg|svg|woff2?|ico)(?:$|\?)/i.test(event.path)) return 'static';
  if (event.path === '/') return 'root';
  if (/^\/(?:api|graphql)(?:\/|$)/i.test(event.path)) return 'api';
  return 'other';
}
