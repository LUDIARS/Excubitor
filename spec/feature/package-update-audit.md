# Package update audit {#SPEC-PACKAGE-UPDATE-AUDIT}

実装は `@implements SPEC-PACKAGE-UPDATE-AUDIT` でこの条項を参照する。

## Purpose

Project-local dependencies and globally installed CLIs must be checked without waiting for a
manual question. The daily report lists the package, every project using the same version,
the current and new versions, release notes, and npm vulnerability alerts.

## Placement and lifecycle

Package auditing belongs to Excubitor's existing update domain, but it does not run in the
backend scan loop:

- git behind/ahead remains in `src/update/checker.ts`;
- package collection, classification, vulnerability scanning, and reporting live under
  `src/update/package-audit/`;
- `npm run packages:audit` is the interactive/cron-compatible entry point;
- `npm run packages:audit:daily` sends through the dedicated Discord webhook;
- no additional daemon or long-lived watcher is introduced.

Registry checks can take minutes across the catalog and should not delay backend startup or
HTTP update requests. Windows runs the built CLI through Task Scheduler. Other platforms can
invoke the same daily script from cron.

## Modules

`src/update/package-audit/` holds one responsibility per file:

- `cli.ts` — argument parsing and process exit codes;
- `auditor.ts` — combines the local and global audits into one report;
- `targets.ts` — catalog working directories that own a `package.json`;
- `local-auditor.ts` / `global-auditor.ts` — per-scope collection;
- `npm-client.ts` — every `npm` invocation and registry read;
- `classify.ts` / `native-detector.ts` / `update-factory.ts` — one update record and its category;
- `aggregate.ts` / `internal.ts` / `vulnerability.ts` — deduplication and merging;
- `release-notes.ts` — GitHub release lookup;
- `format.ts` / `discord-report.ts` — text and Discord rendering;
- `types.ts` — the report shape.

Configuration lives in `src/update/package-audit/config.ts`, the encrypted webhook in
`src/secrets/config-store.ts`, and the HTTP surface in `src/secrets/router.ts`.

## Targets

Local targets come from the merged Excubitor catalog. Service working directories that contain
`package.json` are deduplicated, while all `project_code` values remain attached to the result.
This reuses the same managed-project boundary as git update checks and avoids scanning temporary
worktrees or unrelated folders.

Global targets use a hybrid source:

1. `npm ls -g --depth=0 --json` is the measured inventory and includes unlisted global packages.
2. The `package_audit:` section of `excubitor.config.yaml` declares required CLIs and maps non-npm
   installers to a package or workspace version source. This catches missing tools such as `claude`
   or `anatomia`.

A required CLI is considered present only when its declared `command` can be invoked and yields a
version. Finding the corresponding package in `npm ls -g` alone is not sufficient because its
executable shim may be missing or broken. Command and version-argument configuration rejects shell
metacharacters before execution; commands are otherwise launched with an argument array.

Service definitions belong to each owning repository's `excubitor.catalog.yaml`, so `catalog/`
carries no Excubitor-owned configuration. Audit policy is Excubitor's own runtime policy and
therefore lives in `excubitor.config.yaml` with the other operational settings. The section is
optional: a missing `package_audit:` key still yields a working audit with no declared global CLI.

## Classification

Each update has one display category:

- `safe`: `wanted` equals `latest`, so the new version is inside the declared range;
- `major`: `latest` is outside the declared range. Global CLIs compare semantic versions, with
  a `0.x` minor boundary treated as breaking;
- `native`: the installed manifest indicates `binding.gyp`, native build tools, binary metadata,
  or native install scripts. This category takes priority because reinstall/rebuild is required,
  while `semverImpact` still records safe versus breaking.

Unknown/non-semver versions are never labeled safe.

## Vulnerabilities and release notes

Each catalog package-lock target runs `npm audit --json`. Advisories are deduplicated by package,
severity, vulnerable range, and fix version, then their project sets are merged. Missing lockfiles
are reported as coverage gaps. Absolute working directories are not included in report records,
and npm failure diagnostics redact audit-target paths, URLs, and common credential assignments
before they can enter JSON output, local logs, or Discord messages. Advisory links are limited to
HTTPS GitHub Security Advisory URLs rather than forwarding arbitrary hosts from audit output.

For each unique package/version update, npm registry metadata supplies the repository. Only
GitHub repositories are queried, through a fixed `api.github.com` endpoint, and release tags are
matched to the target version. `GITHUB_TOKEN` is optional and increases the API rate limit.
When no matching release exists, the report says that notes were unavailable and links to the
repository releases page rather than inventing a summary. Report links are restricted to HTTPS
`github.com` URLs; arbitrary package homepages and release-response hosts are not forwarded.

## Dedicated Discord webhook

Package reports never use the downtime webhook. The dedicated URL is stored under
`settings.notifications.packageAuditDiscord` in Excubitor's encrypted config store, or supplied
as `EXCUBITOR_PACKAGE_AUDIT_DISCORD_WEBHOOK_URL`. The URL is normalized with the existing Discord
allowlist, omitted from API responses and logs, and used with Discord mentions disabled.

Configuration endpoints:

- `PUT /api/v1/config/notifications/package-audit/discord`
- `POST /api/v1/config/notifications/package-audit/discord/test`
- `GET /api/v1/config/notifications`

Long reports are split at item boundaries below Discord's 2,000-character message limit. If one
item is itself oversized, it is continued across messages without dropping content.

## Scheduling

After building and configuring the dedicated webhook, Windows users may register the daily task:

```powershell
npm run build
.\scripts\install-package-audit-task.ps1 -At 09:00
```

The installer only registers the task; it does not start it. Each execution writes a dated local
log under `logs/package-audit/` and posts one complete report even when no updates are available.

## CLI contract

```text
npm run packages:audit -- [--json] [--discord] [--local-only|--global-only] [--config PATH]
  [--no-release-notes] [--timeout-ms N] [--concurrency N] [--fail-on-updates]
```

Structured output is written only to stdout; fatal diagnostics go to stderr. Exit code `1`
indicates an incomplete audit or missing required CLI. With `--fail-on-updates`, exit code `2`
indicates updates or vulnerabilities were found.

`--config` and `EXCUBITOR_PACKAGE_AUDIT_CONFIG` select the same runtime config for both catalog
loading and package-audit policy. `--local-only` and `--global-only` are mutually exclusive.
