# Excubitor service update

## SPEC-EX-UNIFIED-UPDATE

The federation node detail exposes one Excubitor サービス本体 update target instead of an observation-only supervisor row and an independently deployable ExView row. Catalog process ownership stays unchanged. Component update/deploy/reflect requests for excubitor or excubitor-viewer-dmz fail with 409 use_excubitor_service_target and identify target.kind=excubitor. Generic POST service update has the same guard. Viewer start/stop APIs remain available separately.

### Complete service deployment

Self deploy fetches, installs backend/frontend dependencies, builds both and asks the current supervisor to restart the backend. The new backend recovers the durable operation asynchronously so HTTP readiness is not blocked. After the old supervisor has completed its deferred backend restart, the new backend asks the OS service manager to restart that supervisor:

- Linux: registered systemd user service, MainPID must match the recorded supervisor and KillMode must be process. The synchronous systemctl restart command is launched by the preserved backend, not by the supervisor it stops.
- Windows: the installed per-user scheduled task is queried and stopped. A process handle acquired before stopping waits for the recorded old supervisor to exit, and the task must become Ready before Start-ScheduledTask is called. Both waits share a 45-second bound within the OS command's 60-second limit. A timeout or unavailable/disabled task fails without starting a replacement. Backend and managed services survive via existing WMI breakaway ownership. Legacy Windows Service/NSSM is not supported or used as fallback.
- macOS: the installed user LaunchAgent must declare AbandonProcessGroup=true and launchctl's PID must match the recorded supervisor. kickstart -k replaces only that supervisor job. A boot-time LaunchDaemon (`install-service.sh --boot`, `/Library/LaunchDaemons`) must additionally declare KeepAlive=true and UserName equal to the current account; because kickstart in the `system` domain needs root, the restart is SIGTERM to the verified supervisor pid and launchd KeepAlive starts the replacement.

No direct duplicate supervisor process is spawned. Service names are validated. OS commands have a 60-second timeout, bounded output and hidden windows. A missing/unsafe installation fails the operation explicitly; the installer and unrelated services are not altered automatically.

The supervisor writes a separate atomic data/supervisor-version.json receipt at startup (PID, start time, checkout hash). Existing local-control state schema stays compatible. Completion requires the expected backend hash, changed supervisor generation, receipt matching the live state file, expected supervisor hash and responsive IPC reporting this backend PID. Verification has a 120-second bound. Source hash capture follows the existing backend convention and assumes builds are produced from the checked-out revision; it is not binary attestation.

After supervisor recovery, running ExView is restarted through the new supervisor; stopped ExView stays stopped. Unknown state or failed restart fails the operation. Only then is the full service operation succeeded. restart uses the same complete-service recovery, while update remains fetch-only. reflect checks both backend and supervisor versions before deciding nothing needs updating.

### Interrupted recovery

Before the OS mutation, service_recovery metadata records old generation and supervisor-issued. A subsequent backend boot never resends that ambiguous restart: it verifies the recorded replacement or fails. Viewer restart similarly records viewer-issued before mutation; an ambiguous result is reported rather than replayed. viewer-verified can finish without a second refresh. The queue remains held while recovery is active; normal operations resume afterwards. Shutdown interrupts the bounded wait. No automatic rollback, source reset, service shutdown cascade or deletion is performed.

This recovery also handles first upgrades from an older backend that wrote only expected_hash: the new backend completes supervisor/ExView replacement after boot. The new code must already be present in the checkout and compiled as part of deploy.

### Validation

User approved supervisor restart scope on 2026-09-28. Source evidence: observation-only catalog entry and managed-only NodeDetailPanel buttons. Problem log remains in main at spec/plan/problem_logs/2026-09-28-excubitor-self-update-target-split.md.

Static TypeScript checks and diff inspection are performed. Recovery tests use injected/mocked OS control only and cover durable intent, interrupted restart, ambiguous viewer state and OS command failure. They are added for the review pipeline, not executed by this session. Actual AWS/Windows/macOS lifecycle verification is not performed by this implementation task.
