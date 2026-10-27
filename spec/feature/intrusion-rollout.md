# Intrusion monitor activation and recovery

Related: `SPEC-EX-INTRUSION-MONITOR` in intrusion-monitor.md. These are deployment
instructions, not evidence that either production site has been activated.

## Per-site configuration

Store a UTF-8 JSON config outside version control and point
`EXCUBITOR_INTRUSION_CONFIG` to its absolute path in the Ex supervisor environment.
The listener port belongs to the `excubitor` service's `public-ingress` catalog
entry. Do not copy a port into this config or point any tunnel at the management
port. The same implementation runs on Windows headquarters and Linux AWS.

Example (replace all example values; these are not deployed settings):

```json
{
  "site": "headquarters",
  "allowedCountries": ["JP"],
  "requestsPerMinute": 600,
  "authFailuresPerMinute": 20,
  "routes": [
    {"hostname": "app.example.com", "service": "example-service", "origin": "http://127.0.0.1:8080"}
  ],
  "tunnels": [
    {"id": "a4e50a50-1a8e-4ca0-a4bc-b394e95f1271", "hostnames": ["app.example.com"]}
  ]
}
```

Origins must be exact loopback HTTP ports declared by their catalog service.
The configuration supports one origin per hostname (all paths). Existing
path-based splits, HTTPS-only origins, wildcard hosts, non-HTTP tunnels and direct
AWS listeners require a separately reviewed migration; do not silently skip them.
Ex management/federation/the gateway itself cannot be upstream targets.
All hostname entries must be in the existing Cloudflare broker allowlist.

Use Ex Vault for `CF_API_TOKEN`, `CF_ACCOUNT_ID`, and
`EXCUBITOR_SECURITY_DISCORD_WEBHOOK`. The webhook must be a private security
destination; its value must not appear in the configuration, logs or task text.
Do not reuse a public reporting webhook by inference. No new npm dependency or
install script is required. Authentication/credential storage uses the existing
Vault and Cloudflare clients, not custom cryptography.

## Activation sequence

1. Inventory both sites' public DNS/tunnels, AWS security-group ingress, direct
   listeners, IPv6, and alternate origins. Confirm the private management/recovery
   path. Country-based isolation can intentionally stop all legitimate public
   clients after a single foreign request; acknowledge this operational policy.
2. Verify CF Access protection and that IP geolocation supplies `CF-IPCountry`;
   no header-removal/Worker transformation may falsify the trust assumption.
   Missing country/IP fails closed. Cloudflare cache hits and edge-rejected
   traffic are outside this origin gateway's observation scope.
3. Obtain review/test evidence. Deploy via Ex from the main checkout to each site.
   Start with configuration absent; GET `/api/v1/intrusion` must say unconfigured.
4. Set the validated config and Vault entries; restart through the supervisor.
   `armed` only means the gateway is listening, not that every public route is
   covered. The status deliberately continues to say coverage unverified.
5. Preserve original tunnel configuration in an access-controlled recovery record.
   Repoint the inventoried hostname rules to the catalog gateway endpoint,
   preserving Access and origin headers. Disable origin-bypassing public paths
   and CF cache serving where strict immediate cutoff is required.
6. POST `/api/v1/intrusion/verify` performs read-only CF checks; it must report
   `configured_tunnels_verified`. It explicitly does not certify other tunnels,
   direct listeners, cached responses or already-served content.
7. With authorized test fixtures, verify domestic success, trigger rejection,
   immediate termination of HTTP/WebSocket connections, durable restart latch,
   remote CF rule readback, and real Discord delivery. Record AWS and headquarters
   independently; an unreachable site stays unverified.

Cloudflare and Discord communication occurs only for explicit coverage verification
or incident handling (including a persisted incident/unclean restart at startup).
CF receives configured tunnel IDs/configuration and its Bearer token. Discord
receives only the redacted incident summary using the Vault webhook. The gateway
forwards client requests only to configured local origins; it runs no shell,
dynamic code or child process. Configuration absence disables these new paths.

## Recovery

There is deliberately no automatic reset API. Keep public CF routes blocked while
investigating from private management. `data/intrusion.sqlite` contains the durable
incident, crash marker and first pre-containment tunnel snapshots. Back it up with
its SQLite WAL using an SQLite-aware backup; do not delete a live DB/WAL.
After incident resolution and explicit operator approval, stop Ex through its
supervisor, archive the incident DB safely, and prepare a fresh state DB. Restart
the gateway with the verified policy while CF remains blocked, then restore only
the reviewed routes to the gateway, not old direct origins. Re-run coverage and
delivery checks. Removing the config alone must never be treated as recovery.

The local gateway remains closed even if CF/API or Discord is unavailable. A
persisted running marker converts unclean restart into a blocked incident. An
incident DB read error prevents opening the listener. No exactly-once Discord
guarantee is claimed; stable incident IDs identify possible delivery duplicates.

## Current deployment blockers

- AWS peer observed as `mesh_security_not_configured` on 2026-10-27.
- Actual site-to-tunnel/hostname inventory and private security Discord destination
  are not yet established for this change.
- Session has not run unit/integration/live tests; explicit test authorization is
  required under the session rules. Source/type checks are separate evidence.
