# Security defense and daily reporting

Approved scope: neco requested implementation of the five proposed defenses, daily reporting, and inclusion of tshark results (2026-11-05).
Actio: 38b53dd5-5f7d-446b-b6d6-0063ccb7a58a

## Behavior

Public-ingress evidence now preserves decisions and correlation without retaining raw sensitive URLs. Service policies add observed request/404/auth-failure bursts and opt-in short-lived client limits. Existing country/path checks remain mandatory. Unconfigured service limits retain legacy behavior.

Background host observation fingerprints selected service manifests/lockfiles/Node entrypoints, account/startup configuration and authorized keys. A complete exact candidate must be explicitly approved before it becomes a trusted baseline. Reads SSH authentication signals, existing process snapshots and netwatch snapshots; all missing/failed sources remain explicit. No public listener, firewall mutation, service stop or remote SSH connection is added.

At 09:00 JST, persist and send the previous day's aggregate report through the existing security webhook. Record the delivery attempt before network I/O; timeout/crash remains unknown without duplicate retries. Daily summaries include tshark observation deltas, country and associated port/process breakdowns, suspicious destinations and collection gaps. Local JSON reports retain full aggregate detail for 90 days (API returns newest 30).

## Validation

- TypeScript `tsc --noEmit` and `git diff --check` passed during implementation.
- Session did not run unit/integration/startup tests, per session policy. New test fixtures cover request-policy isolation/TTL, privacy, baseline approval/diff, JST boundaries, delivery uncertainty across reopening SQLite, and tshark delta/coverage reporting.
- Revisor should run new `src/security-defense/*.test.ts` plus existing `src/intrusion/*.test.ts` suites.
- No new dependencies, installation scripts or lockfile changes. Uses existing better-sqlite3/Hono/Zod and Node standard crypto/fs/child_process. Native read commands have fixed program text, bounded output/time, restricted environment and hidden Windows execution. Only outbound connection added is the authorized daily summary to the existing validated Discord webhook; secret is resolved by the existing Vault path and never serialized into reports.

## Deployment / limits

- Requires the reviewed build to be reflected in the project root runtime. No worktree startup or live restart performed during implementation.
- Existing ingress config/security webhook are prerequisites. If ingress is unconfigured this runtime is unconfigured too. Does not claim protection of AWS or other hosts without running there.
- No CF logging purchase/setup. Validated Ray ID is preserved for future edge correlation.
- Native tools/log permissions and tshark must already be available; collection is reported failed/disabled otherwise. No privileged task or tshark instance is installed.
- Exact auth paths and a trusted baseline require operator input; HTTP 200 is never a successful-login assertion. Sampled OS/process/network observations are not forensic completeness.
- New heuristic mode defaults to observe; explicit enforce limits are scoped, at most 15 minutes, and reset on restart. Restart/first observation gaps are retained.
