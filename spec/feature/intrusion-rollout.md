# Intrusion monitor activation and recovery

Related: `SPEC-EX-INTRUSION-MONITOR` in intrusion-monitor.md. These are deployment
instructions, not evidence that either production site has been activated.

## Per-site configuration

Store a UTF-8 JSON config outside version control and point
`EXCUBITOR_INTRUSION_CONFIG` to its absolute path in the Ex supervisor environment.
Alternatively, explicitly create `data/intrusion-config.json` in the main checkout;
this avoids changing the OS supervisor environment. Missing default file is inert;
invalid/unreadable configuration is never treated as missing.
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

Origins must be exact private IPv4 HTTP ports declared by their catalog service:
loopback, RFC1918 or Tailscale's 100.64.0.0/10 range. DNS names and public/metadata
addresses are rejected; configuration is operator-owned, never client-derived.
For path-based rules, configure the original `path` and a unique `routeKey`
(`r-<identifier>.intrusion.invalid`). Cloudflared retains its original path match,
then forwards to the gateway with `originRequest.httpHostHeader` set to that key.
The gateway restores `forwardHost` (or the public hostname) before HTTP/WebSocket
proxying. It does not evaluate Cloudflare regular expressions in JavaScript.
`planGatewayRoutes` produces a pure migration plan, checks the original origin/Host,
and preserves rule ordering, paths, Access options and fallback. Compare the whole
saved configuration with a fresh read before applying a reviewed plan; do not
overwrite concurrent edits. `verifyCoverage` checks exact path/key correspondence.
Exact CloudFront HTTPS origins and existing legacy/private origins can be adopted
only with original-rule proof as described in `intrusion-origin-adoption.md`.
Ex management additionally requires the original cloudflared Access validation.
Federation/the gateway itself cannot be upstream targets. Other HTTPS origins,
wildcard hosts, non-HTTP tunnels and direct AWS listeners still require separate
coverage; do not silently skip them.
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
   For every adopted route, set `adoptExisting: {tunnelId, sourceHash}` and a unique
   route key. Generate `sourceHash` with `publicRuleHash` over the original rule
   and tunnel configuration. First startup must still see the original CF rule;
   it writes only local approval receipts and does not change CF. Keep
   `data/intrusion-origin-approvals.json` across incident recovery. Copy it only
   with the matching site's reviewed config; missing/stale proof fails closed.
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
forwards client requests only to configured private origins; it runs no shell,
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
- The AWS/LOCAL Cloudflare configurations have been inventoried. They include
  existing Ex management exposure and an external HTTPS origin, which the gateway
  deliberately cannot proxy. These need an explicit deployment disposition; partial
  routing must not be reported as whole-site coverage.
- Private security Discord delivery was verified independently from headquarters
  and AWS on 2026-10-27; the security webhook is in each site's Ex Vault. This does
  not certify incident-triggered delivery or containment, which remain live tests.
- Activation and verification were authorized on 2026-10-27. Authorization does
  not constitute successful deployment or live verification of either site.

## Compatibility correction review

The path/Host migration and private IPv4 validation use Node standard libraries
and the existing Zod dependency. No dependency, install hook, authentication or
cryptographic implementation is added. The planner is pure and performs no
startup/network communication. Existing opt-in runtime behavior is unchanged:
client headers/body stream to the configured origin; CF configuration and bearer
credentials go only to CF's existing client; redacted incident summaries go only
to the configured Vault webhook. Unconfigured startup opens no intrusion listener.
