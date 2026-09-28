import { serviceTier, type Service } from '../catalog/loader.js';

/** Known game entries whose runtime is a web server rather than a desktop executable.
 * Keep this classification separate from source repositories and bootstrap readiness.
 * @implements SPEC-SERVICE-INSTALL-CANDIDATES
 */
const GAME_SERVICES = new Set(['pagus', 'ludellus-server', 'ludellus-realtime']);
const BROWSER_SERVICE_SUFFIX = /-(?:web|client)$/;

// These standalone services support site placement despite their legacy personal tier.
const SITE_PERSONAL_SERVICES = new Set(['actio', 'actio-web', 'tabula']);

export function isServerInstallCandidate(service: Service): boolean {
  if (serviceTier(service) === 'local-app' || ['app', 'android'].includes(service.runtime)) return false;
  if (serviceTier(service) === 'personal' && !SITE_PERSONAL_SERVICES.has(service.code)) return false;
  if (BROWSER_SERVICE_SUFFIX.test(service.code) && !SITE_PERSONAL_SERVICES.has(service.code)) return false;
  if (GAME_SERVICES.has(service.code)) return false;
  if (['excubitor', 'excubitor-viewer-dmz'].includes(service.code)) return false;
  return !service.disabled;
}
