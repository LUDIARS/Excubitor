# Service-scoped user access logs

Authority: neco, 2026-10-28: keep the current log, add user access logs with CF ID and User-Agent, emit only the first consecutive access inferred to be the same user, separately for each service.

Domain: `intrusion` (supporting public-ingress observation, not a new core domain).
Value: `EX-USER-ACCESS-01` makes visits understandable without suppressing security evidence.

## Metadata

Record timestamp, configured service/hostname, CF country, CF-Ray, bounded User-Agent and Accept-Language, daily IP hash and daily inferred visitor hash. CF-Ray is request correlation, not a user ID. The origin headers are observations, not authentication. This change does not decode Access JWTs or retain bearer tokens, cookies, raw IPs, URL queries, bodies or arbitrary headers. It adds no dependency, external lookup or outgoing traffic.

## Deduplication

The key is service + daily hash of IP, User-Agent and Accept-Language. First arrival is recorded before the existing detection policy, including rejected access and WebSocket upgrade attempts. Further accesses to that service refresh a 30-minute inactivity window without another user log. Another service always has its own first entry. Same-service hostname aliases share a visit; the first hostname and CF-Ray are retained.

This is an inferred visitor, not a proven person/device. Shared IP + identical browser information can merge people; changed IP/browser information can split them. Missing UA/language are empty strings and make inference weaker. Entries reset on UTC day boundary or process restart. A 10,000-entry LRU cap may emit a new first entry after eviction. Cache insertion happens only after successful append; failures warn, surface `userAccessLogging: failed`, and retry on the next unsuppressed observation without blocking traffic. Successful append clears failure. No timer or open file descriptor is retained.

## Storage

Current `excubitor-intrusion/YYYY-MM-DD.jsonl` security evidence stays unchanged and is not deduplicated. Separate Vg-compatible streams are `excubitor-user-access-<service>/YYYY-MM-DD.jsonl` under the shared logs root, discoverable by existing file-tail. They are arrival logs, not response-completion or pageview counts. Log directories/files request 0700/0600 permissions; deployment OS ACLs remain authoritative. Existing log lifecycle applies. No new public log endpoint is introduced.

## Acceptance

- Same visitor/service burst emits one user entry while existing security logging is unaffected.
- Different service, IP, UA or language emits a distinct entry; new Ray alone does not.
- Sliding idle expiry, UTC day, process restart and cache eviction can start a new visit.
- Sanitization bounds headers and excludes authentication material; malformed Ray is null.
- Write failure stays visible and retries without losing the first entry.
- Gateway passes metadata for ordinary and upgraded requests before policy decisions.

Investigation: Anatomia plan/where selected existing intrusion and logging domains. Registered Pf project describes service overview, not this feature; this file is the feature specification. Cloudflare reference: https://developers.cloudflare.com/fundamentals/reference/cloudflare-ray-id/
