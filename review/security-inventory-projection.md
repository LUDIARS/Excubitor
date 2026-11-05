# Bound Windows security inventory serialization

The daily security collector timed out after 15 seconds while recursively serializing Windows SID and scheduled-task CIM objects. Because SSH collection follows inventory, both coverage sources became failed even though the local logs were readable.

Project stable scalar account and task/action fields, and registry value names/values without PowerShell provider metadata. Keep deterministic ordering, the existing 15-second timeout, 4 MiB limit, secret-free child environment and in-process hashing. This changes candidate fingerprints; it does not approve or replace a trusted baseline automatically.

## Validation

- TypeScript noEmit and diff checks passed; no unit suite run by the session.
- Read-only comparison on the affected Windows host: old command exceeded 15 seconds without output; projected command completed in 1756 ms, valid JSON, empty stderr, 7 accounts / 232 tasks / 14 autorun entries. Raw values were not logged.
- OpenSSH/Operational is enabled and accessible; the recent 15-minute query returned zero events.
- Revisor should check scalar projection, collection failure semantics, and existing host-observer regression tests. No service should start from a worktree.

## Reflection

After merge, build only the main project root and restart the backend via Ex HTTP under a Cc testing claim. Verify new host_inventory and ssh coverage samples; retain earlier failed samples as history. Daily delivery remains scheduled for 09:00 JST, not forced by this change.
