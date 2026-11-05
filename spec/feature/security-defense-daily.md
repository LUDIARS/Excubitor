# Security defense and daily reporting

SPEC-EX-SECURITY-DEFENSE-DAILY

Approved by neco on 2026-11-05: implement the five proposed defenses and daily reports.

## Contract

- Extend existing intrusion monitoring; never expose management APIs through a new public listener.
- Preserve existing ingress policy. New heuristics default to observation. An explicit enforce setting permits only short, service/client-scoped request limits, never host isolation or global tunnel shutdown.
- Persist decision, rule, source, safe route category, request ID and validated CF Ray ID. No raw URL, query, cookies, body, command line or credentials in evidence or notifications.
- Scope counters by service and client. Authentication detection requires explicitly configured exact authentication paths; a 200 response alone never proves a successful login.
- Host collection reads SSH authentication events, account/startup/key-file fingerprints, existing process snapshots and existing netwatch observations. Missing, failed, stale or unsupported collection is reported as a gap, never zero attacks.
- File baselines are candidates until an operator approves the exact snapshot digest through the existing management API. Never automatically approve the running environment or replace an approved baseline after a deployment. Approval is a trust assertion, not proof the host is clean.
- Compare only configured files and bounded metadata inventories. Hash file contents; do not store their plaintext. Watch additions/deletions under configured bounded directories, never follow symlinks.
- Persist per-day counters, findings and collection coverage in SQLite. Day boundaries are Asia/Tokyo. At 09:00 JST send the previous day's report to the existing EXCUBITOR_SECURITY_DISCORD_WEBHOOK. Initial partial day and missing observations are labeled.
- Before attempting delivery persist an attempt marker. A crash/timeout leaves delivery unknown and is not automatically resent. Reports remain readable locally. No report is silently marked delivered.
- Keep 90 days of aggregates/reports. Bounded finding keys and observer maps prevent untrusted input from creating unbounded memory/disk work. No raw network address in reports.
- CF-side blocked/cached requests and remote hosts remain unobserved unless separately integrated. Ray ID enables future CF correlation; this change does not purchase or enable Cloudflare logging.

## Configuration and management

Optional `data/security-defense.json` (or EXCUBITOR_SECURITY_DEFENSE_CONFIG) sets mode, service rules, watchPaths, dailyHourJst and temporary block duration. Invalid explicit configuration fails visibly. Absent configuration uses documented observation defaults.
All configured ingress services receive observation counters. Existing country/path and legacy request limits remain active unless an explicit service policy replaces the legacy counters; country/path checks always remain active. Authentication routes are never guessed. Temporary heuristic restrictions are in-process and reset on restart; the durable daily report records startup gaps. OS-specific collector limitations are explicit: Linux journal SSH events and selected account/system files; Windows OpenSSH Operational events and local account/scheduled task/Run-key inventory. Event log absence does not prevent approval of a complete independent file/account inventory.

tshark is reused through the existing netwatch snapshot (no second capture process). Report observed deltas by country and associated ports/processes, unknown process attribution, capture health, and direct-IP/unusual-port indicators. These are selected-field observations, not packet payloads, exact bandwidth, or proof of malicious activity. A destination associated with several ports/processes contributes to several associations; do not sum those as disjoint traffic. First snapshots establish counters instead of assigning earlier capture history to today. Five-minute sampling can lose evicted/reset entries and allocates deltas to the observation day. Disabled capture is reported, never automatically enabled or granted elevated privileges.
GET `/api/v1/intrusion/defense` returns cached collection status and baseline status.
GET `/api/v1/intrusion/defense/reports` returns recent saved daily reports and delivery states.
GET `/api/v1/intrusion/defense/baseline/candidate` exposes the candidate fingerprints and local paths to the existing guarded management UI/API for review. No file contents are returned; paths do not enter daily notifications.
POST `/api/v1/intrusion/defense/baseline/approve` accepts `{digest,note}` of the current complete candidate. Reject stale or incomplete candidates.

## Acceptance / review

Verify privacy/redaction, per-service independence, normal high-volume browser traffic, auth route matching, TTL expiry, collection failures, baseline addition/change/deletion and stale approval, report date boundaries, restart recovery and no duplicate delivery after uncertainty. Session does not run tests without explicit permission; submit fixtures to Revisor.
