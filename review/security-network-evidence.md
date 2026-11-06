# Preserve inspectable network findings

neco could not investigate the two suspicious destinations in the first daily report because only IP hashes were retained. On 2026-11-06 the user explicitly requested real IP retention. New suspicious observations now persist real IPv4/IPv6 addresses with bounded domain, port, owner PID/name/service, reasons and observation/detection times. Attribution changes retain separate snapshots; daily counts group by IP. No historical hashes are reverse-inferred and already-sent reports remain unchanged.

The existing guarded management API exposes `/api/v1/intrusion/defense/network?day=YYYY-MM-DD`, including today's records. Daily report JSON retains all admitted snapshots; the Discord text includes two compact examples and the detail route. A 1000-snapshot/day cap and 90-day retention bound disk growth; overflow is visible. Snapshot metadata stays immutable while first/last times and repeated counts advance.

## Validation
- TypeScript noEmit and diff checks passed. No session unit/service tests run.
- Fixtures cover persistence across reopen, changing owners, grouping multiple reasons by IP, report readability/length, expiry and legacy hash-only reports.
- An deterministic plan completed (hash865d95a5ed67bcff), existing intrusion domain; no new domain. Source contract SPEC-EX-SECURITY-DEFENSE-DAILY updated. Pf endpoint responded but specification content was not retrieved, so no Pf synchronization claimed.
- Revisor should run security-defense host-observer/persistence/network-evidence suites and verify API date validation and management protection.

## Dependencies and communications
No package/lock changes or install performed. IP validation uses Node net.isIP instead of adding an IP parser; timestamps/JSON use standard APIs. Existing better-sqlite3 13.0.3 (MIT, node-addon-api transitive dependency, install script present) is reused without rebuilding/installing it; replacing the database would introduce compatibility/migration risk outside this fix. TypeScript5.9.3 (Apache-2.0) reused for static checking. No new duplicate dependencies. Existing native addon safety is not newly audited by this change.

No dynamic execution, child processes, decoded execution, environment/credential export or startup communication added. Existing tshark snapshot is reused. Existing Discord HTTPS webhook receives the user-authorized destination metadata in daily messages; URL credentials remain in Vault, allowed-host validation and redirect:error remain, allowed_mentions.parse=[] prevents notification injection. Local guarded API/SQLite store the complete bounded evidence; payloads, command lines and secrets are not collected. No other traffic is introduced; optional startup package checks stay disabled in this host configuration.

## Reflection
After Revisor merge: root-only build and Ex HTTP restart with Cc claim/release. Confirm endpoint is available and future real observations persist. Do not generate attack traffic or send another daily report to fabricate verification. Original two hashes cannot be recovered by this deployment.
