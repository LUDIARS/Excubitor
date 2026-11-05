import type { AccessEvidence, DetectionReason } from './detection.js';

export interface AccessDecision {
  source: 'gateway' | 'upstream';
  action: 'allow' | 'deny' | 'observe';
  reason: DetectionReason | 'none' | 'temporary_limit' | 'not_found_burst';
}

/** Categorize without persisting arbitrary path segments (which may contain credentials). */
export function safeRouteCategory(event: AccessEvidence): string {
  if (/\.(?:css|js|png|jpg|jpeg|svg|woff2?|ico)(?:$|\?)/i.test(event.path)) return 'static';
  if (event.path === '/') return 'root';
  if (/^\/(?:api|graphql)(?:\/|$)/i.test(event.path)) return 'api';
  return 'other';
}
