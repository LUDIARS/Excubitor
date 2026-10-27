# JP availability with per-request intrusion filtering

User authorization: neco, 2026-10-28: JP access must be allowed and logged.

Explicit `enforcement: request-filter` replaces the site's global shutdown policy. The absent
field retains legacy `site-cutoff` compatibility. JP remains the configured allowed country.
Foreign, missing/invalid identity, exploit-path and request-burst events reject only that request;
normal allowed-country requests continue. Authentication response bursts are observed and reported.
Allowed upstream responses and denied requests write Vg security_access records. Logging failures
are visible in status and warnings, never interpreted as successful logging or site-wide cutoff.
Discord reports are rate limited globally to one attempt per minute, with no unbounded queue.
They state that the site remains open and contain no raw client address, path, query or headers.

In request-filter mode an old persisted incident is historical (`previousIncident`), not an active
latch. Neither it nor an unclean-restart marker calls Cloudflare containment or closes unrelated
connections. The incident database and original-route approval receipts are preserved. No routes
are automatically reopened: the operator must explicitly restore the existing reviewed gateway
configuration after the new policy is running and verified. Existing Access/path/Host restrictions
and private management paths must remain intact.

Acceptance: a foreign or malicious request is denied and logged; a subsequent normal JP request
succeeds and is logged. Restart with an existing old incident does not activate global containment.
Notification/log failure does not block unrelated JP visitors. Controlled restoration checks all
44 HQ tunnel routes and actual JP traffic. Direct IP/Tailscale exposure remains a separate scope.
