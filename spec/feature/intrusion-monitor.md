# Public ingress intrusion monitoring {SPEC-EX-INTRUSION-MONITOR}

2026-10-28 policy amendment: explicit `enforcement: request-filter` keeps normal JP
access available and logs access while rejecting individual suspicious requests.
See `intrusion-request-filter.md`; the global cutoff lifecycle below applies only
to the legacy/default `site-cutoff` policy. Switching policy does not reopen CF routes.

Ex owns the monitoring and containment at headquarters and AWS. Each site runs
its own guard; loss of federation must not disable local protection. Vg remains
the access-evidence format, not the decision maker. The supporting intrusion
domain protects the service-operation domain.

## Boundary and activation

An explicitly configured loopback HTTP gateway sits between cloudflared and all
public HTTP/WebSocket origins. Host-to-origin mappings are operator-owned,
never request-controlled. No management router is mounted on this listener.
An already-public Ex management origin can only be proxied through explicit,
persisted adoption of its existing Access-protected rule (see
`intrusion-origin-adoption.md`). Federation, SSH and outbound Discord remain
outside this listener. Direct public origins, alternate tunnels and non-HTTP
ingress must be inventoried and closed separately before claiming site coverage.
The gateway cannot see traffic rejected or served from cache at Cloudflare.

Configuration is absent by default: status is `unconfigured`, not `protected`.
Activation requires exact tunnel IDs/hostnames, service origins, JP country
policy, a private security Discord webhook in Vault, and confirmation that all
public routes use the gateway. Existing Access settings must be preserved.
Cloudflare IP geolocation must be enabled; headers are trusted only because the
listener is loopback-only behind the configured Tunnel, under the existing
trusted-local-process model. Missing/unknown country information is rejected,
not silently accepted as domestic. Do not use X-Forwarded-For for identity.

## Detection and containment

Before forwarding, evaluate verified country metadata, bounded request rates,
and explicit exploit-path indicators. Defaults: only JP; foreign country/Tor,
path traversal, exposed credential/config probes, and a configured request burst
trip a site-wide latch. HTTP authentication failures can also trip a bounded
per-client window. These deterministic indicators are not a claim of complete
WAF coverage or proof of intrusion. Country exceptions are explicit configuration.

Persist the incident before asynchronous work. Immediately deny new public
forwarding and terminate existing public connections. A persistence error keeps
the in-memory latch closed and is reported as an error. Restart loads the latch;
there is no automatic reopening or timeout-based recovery.

Ex then replaces every configured public hostname rule in each configured tunnel
with `http_status:503`, retaining unrelated rules, Access options and catch-all.
Read back configuration before recording containment as confirmed. Partial or
failed containment remains visible and retryable; a retry first reads current
state. Never delete DNS, tunnels, Access applications or firewall management rules.
An explicit maintenance recovery restores verified routes and clears the local
latch only after investigation; this change provides no automatic reset endpoint.

## Evidence and reporting

Record access evidence in Vg JSONL with a structured `ctx.evt=security_access`.
Never record cookies, authorization, raw query strings, bodies or header dumps.
Discord carries incident ID, site, rule, service, timestamp, and containment state;
no full IP or request URL. Delivery failure cannot reopen ingress. Persist delivery
state and retry with bounded delay. A crash after remote delivery may duplicate a
message; the stable incident ID makes that explicit (not exactly-once delivery).

## Acceptance and rollout

Verify safe/foreign/unknown country, spoofed forwarding metadata, malformed paths,
bounded rate state, concurrent incident deduplication, restart latch, partial CF
failure/readback, Discord failure/retry, redaction, HTTP/WebSocket teardown and
unrelated-route preservation. Session tests require explicit authorization; Revisor
owns review checks. Rollout requires separate evidence for headquarters and AWS,
including preflight of origins, tunnel coverage, Access and private recovery path.
No live attack probe or production cutoff is performed merely by adding code.

## Investigation evidence (2026-10-27)

- Base: `aa0140bbbe1e2e245e2c773e675439adbdfebe76`.
- Vg DESIGN.md §2.2: service JSONL with arbitrary `ctx`; not universal access middleware.
- `src/log/file-tail.ts` currently reduces structured records to `msg`.
- `src/cf-tunnel/cloudflare-api.ts` and `route-service.ts`: existing scoped CF broker.
- Pf project `01M3CKBF6EEVVWNPPSCJYXW43R`: existing monitoring UX, no intrusion specification found.
- An context/plan for registered `excubitor`: reuse cf-tunnel, logging and notification boundaries.
- Genius query unavailable; no judgment cards were assumed.
- Live AWS peer read: `mesh_security_not_configured`; deployment unverified.
- Task creation returned `actio:aca2dcc7-27b7-4c08-8f5c-82fa88eea959`; subsequent
  content/link reads initially returned `actio_unavailable`. A later successful
  authoritative read allowed instruction-link registration and in-progress
  ownership recording. No completed status was inferred from the failed reads.
- Cloudflare reference: https://developers.cloudflare.com/fundamentals/reference/http-headers/
  and https://developers.cloudflare.com/network/ip-geolocation/ (country can be XX/T1).
