# Service bootstrap and Taildrop data migration

## SPEC-SERVICE-BOOTSTRAP

Excubitor owns clone, durable operation history and supervisor start. Services own dependency installation, setup and data semantics. Castra owns the shared skill at .agents/skills/service-bootstrap/SKILL.md (Claude discovery forwards to that source).

### API

The existing loopback POST /api/v1/operations and authenticated peer relay POST /api/v1/peers/:id/operations accept these additional service actions. The federation listener retains existing bearer/HMAC mutual registration. No public ingress is added.

~~~json
{"target":{"kind":"service","code":"service-code"},"action":"bootstrap","bootstrap":{"repository":"LUDIARS/Repository","start":true}}
{"target":{"kind":"service","code":"service-code"},"action":"data-export","data":{"artifact":"service-20260928"}}
{"target":{"kind":"service","code":"service-code"},"action":"data-import","data":{"artifact":"service-20260928","sha256":"64-lowercase-hex-digits-from-export"}}
~~~

The import hash above is a placeholder and deliberately fails validation. Use the actual export hash. No new action is allowed for the Excubitor self target. Extra bootstrap/data fields on unrelated actions are rejected. Options persist in the existing operation meta column, including through a backend restart. Interrupted running operations fail; queued operations retain their options. Existing update/deploy behavior is unchanged.

Use scripts/service-bootstrap.mjs --url <local Ex origin> [--peer <id>] --request <UTF-8 JSON file>. Check with the same command and --operation <returned id> instead of --request. The CLI does not retry POST and contains no peer credentials. HTTP 202 is not completion; the operation must become succeeded. Frontend history labels include the new actions; submission uses API/CLI rather than a new UI form.

### Clone / setup / start

Only LUDIARS GitHub repositories, fixed main, ordinary checkouts directly under EXCUBITOR_ARS_ROOT are supported. Excubitor self-bootstrap is refused. A destination must be writable by the existing Ex service account; root-owned workspaces require a human to precreate each service directory (as with prepare-host.sh). No sudo, chmod of the workspace, clone of Castra, OS package installation or credential provisioning is implied.

For AWS's root-owned /var/share/LUDIARS, the human can precreate an approved repository directory with install -d -o <Ex-user> -g <Ex-group> -m 0750 /var/share/LUDIARS/<Repository>. Do not recursively change ownership of the workspace.

Existing paths are checked for ordinary .git directories, expected HTTPS origin, main and clean state. Worktrees/symlinks are rejected; no reset, pull or recursive deletion is performed. Failed clone directories remain for diagnosis. The origin update source is required; mesh bootstrap is not implemented and fails explicitly.

The service must provide excubitor.catalog.yaml with matching code/repo/cwd, disabled=false and autostart=false, plus this root manifest:

~~~json
{
  "version": 1,
  "service": "service-code",
  "setup": "scripts/site/setup.mjs",
  "data": {"export":"scripts/site/export-data.mjs","import":"scripts/site/import-data.mjs"}
}
~~~

All three entrypoints must exist inside the checkout before any setup is run. Ex confirms the service is stopped using the existing supervisor. setup runs under Ex's Node executable with checkout cwd, no shell, no sudo, noninteractive. Setup must be idempotent, preserve data/secrets and not launch daemons. Its nonzero exit or 15-minute timeout fails the operation. Output is not persisted because it may contain secrets; scripts own local diagnostic logs. The process and descendants are reaped on timeout.

After setup, catalog identity is checked again and start uses the supervisor. start:false is the migration preparation mode. Service autostart must remain false during setup/import. No automatic stop or rollback is attempted. Operators must not issue competing lifecycle commands while setup/migration is active; service scripts must protect their own storage against concurrent access.

### Data and Taildrop

Both export and import require a verified stopped service and the service-owned manifest. Export receives --output <Ex-cwd>/data/transfers/<code>/<artifact>.bundle; no overwrite is allowed. Ex verifies a regular file and reports SHA-256 in operation steps. The service owns the format (not Git bundle), service identity, version, consistency, sensitive-field exclusions and migration rollback. A data-less service explicitly implements its empty format, not a placeholder success.

Send the artifact with Castra's scripts/taildrop-transfer.mjs <file> <tailscale-device>. It reports a local SHA-256 and successful send, not successful import. Taildrop requires eligible same-owner, untagged nodes. The destination receives with tailscale file get --conflict=skip <directory> under its existing OS permissions.

Import reads <artifact>.bundle ONLY from EXCUBITOR_TAILDROP_DIR, defaulting to the Ex account's ~/taildrop. This is the directory populated by tailscale file get, not tailscaled's internal inbox. A configured path must be absolute; no request-supplied source path or URL is accepted. Symlink/regular-file checks apply. Ex verifies the expected SHA-256 before invoking import with --input <path> --sha256 <hash>. The service script must recheck the hash and archive identity before committing any change, reject unsafe archive paths, and reject existing data or implement its documented backup/restore procedure.

Import does not start the service, delete the received file or delete the source data. After successful import, the operator requests normal start. Secret injection, Cloudflare publication, actual AWS provisioning and validation are separate authorized work.

### Evidence and acceptance

Existing federation contracts: SPEC-FEDERATION-OPERATIONS. Implementation: src/bootstrap/* and src/federation/operations/*. Bootstrap guidance is integrated into Castra CLAUDE.md; no per-service copies of the skill are needed.

Anatomia deterministic plan on 2026-09-28 identified service-startup/http-api as existing domains. Praeforma's returned project listing contained no Excubitor match; no spec registration was created. Actio taskflow lookup returned taskflow_internal_error, so task status/link is unknown.

Acceptance: unknown service can be bootstrapped through the authenticated operation path; clone validation rejects unsafe/existing mismatched paths; setup failure prevents start; start:false supports migration; export refuses existing output; import reads Taildrop and rejects checksum mismatch; state and step failures persist. Tests and actual service operations are not executed without human instruction.
