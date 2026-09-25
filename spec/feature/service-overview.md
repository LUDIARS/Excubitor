# Excubitor service overview

## Scope {#SPEC-EX-SERVICE-OVERVIEW}

neco requested a new main screen, subsequently explicitly requiring retention of existing screens and functions and Pf/Anatomia data. The default route is #overview. Monitor, Dashboard, Logs, Config, Catalog, Errors, Memory, Function Metrics and Federation retain their existing routes.

Each PC/site is a separate section. Within a site, project_code identifies one logical service; its components appear only on #overview/:site/:project. Components from different sites never merge. The top list shows version(s), component count and startup marking. Multiple observed versions remain visible, never silently selecting one. Missing version is 未報告.

State is 稼働 when all enabled components have an observed successful health result; 一部稼働 when some do; ダウン when none do. Disabled components do not inflate availability. Missing observations are marked 未観測 separately; disconnected sites and stale snapshots display a warning rather than implying the old observation is current.

Startup services use a purple edge and a text badge independent of health colors. Configured automatic launch selection takes precedence; without a configured profile the catalog autostart setting applies. Older remote nodes without startup metadata are unknown, never inferred to be startup services.

## Configuration {#SPEC-EX-SERVICE-SETTINGS}

The local component detail edits the service-owned subdomain/frontend URL via catalog-info and complete encrypted runtime config through the existing runtime-config API. Config is a full replacement JSON object, encrypted at rest; values are never fetched back, logged or stored in browser storage. The editor clears the draft after successful save. Keys/status alone are returned. Saving does not restart a service. Injection takes effect on the next spawn only when the target service consumes EXCUBITOR_SERVICE_CONFIG_JSON. Remote configuration remains on the remote node; Federation provides remote lifecycle operations.

## Absolute health rule {#SPEC-EX-HEALTH-CACHE-ONLY}

Health handlers MUST NOT perform database queries, PR/review retrieval, history aggregation, subprocess work, filesystem scans or outbound health probes. Return in-memory published snapshots only. Heavy diagnostics belong on explicit diagnostic routes or background collectors. Authentication uses cached peer credentials refreshed in the background and synchronously after peer mutations, preserving immediate revocation. No request-triggered fallback collector is allowed.

/health retains process identity only. /api/v1/federation/health returns the periodically materialized payload (503 snapshot_pending before the first publication). /api/v1/overview returns a snapshot collected every 10 seconds, retaining the previous successful result on collector failure and exposing generated_at. Probe age is separate from snapshot age. The frontend polls sequentially and aborts on unmount. All background timers are stopped by bootObservability shutdown.

## Acceptance

- One service row per project and site; child navigation and browser Back work.
- Mixed components produce 一部稼働; all-down, unknown and disabled cases cannot become 稼働.
- Startup color does not replace health indicators; versions remain visible in the top list.
- Open/read/refresh health and overview endpoints do not trigger SQL, probes or external review requests.
- Local detail saves host config and encrypted JSON with observable success/failure; secrets are not echoed.
- Legacy routes and capabilities remain available.

## Implementation references

src/overview/model.ts: transport/grouping; snapshot.ts: background collection; cache.ts: publication/HTTP.
frontend/src/overview/: list, child page, settings and scoped visual design.
src/federation/payload-cache.ts: health materialization; public-router.ts: memory-only response.
src/federation/store.ts and peer-auth.ts: cached authentication with mutation refresh.
