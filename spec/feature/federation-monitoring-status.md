# Federation monitoring failure classification

Authority: neco 2026-10-28 requested restoration and correction after all four peers were reported down with `mesh_security_not_configured`.
Domain: federation. Value: distinguish unavailable monitoring from evidence of an unresponsive peer.

Known local missing mesh policy, credentials, peer policy, HTTPS requirement and migration-file errors map to existing `unauthorized`, not `down`. A remote HTTP 503 with explicit `mesh_security_unavailable` also maps to `unauthorized`. Ordinary network failures, generic 503 and incompatible health payloads keep existing behavior. No schema version or authentication permission changes.

Authentication and registration failures send a separate monitoring-unavailable notice once. They do not start or extend the downtime clock. When an authenticated healthy response arrives, send monitoring-resumed rather than suggesting the machine restarted. If a transport outage occurs after configuration failure, its downtime starts then. Only successful notification delivery advances notification state; failures retry. Resource alert state is retained until a healthy observation resolves it.

Operational recovery is separate: Cr workload registration/keys/TLS and peer policy are the target. The documented explicit legacy-monitor migration switch permits only existing registered peers' health/node reads, never operations, bundles or Vault. This patch does not enable that weaker migration policy, create credentials or alter live configuration.

Acceptance: local configuration/remote security errors are classified separately; no false downtime notice after five minutes; authentication recovery wording is accurate; network outages still alert after the grace period; failed notice delivery retries.
