/** Known authentication/configuration failures are not evidence of remote downtime.
 * @spec spec/feature/federation-monitoring-status.md
 */
const LOCAL_CONFIGURATION_ERRORS = new Set([
  'mesh_security_not_configured', 'mesh_credential_not_configured',
  'peer_auth_not_configured', 'mesh_https_required', 'legacy_monitor_only',
  'legacy_monitor_migration_unreadable', 'legacy_monitor_migration_invalid',
]);

export function isLocalMonitoringBlock(error: string | null): boolean {
  return error !== null && LOCAL_CONFIGURATION_ERRORS.has(error);
}
