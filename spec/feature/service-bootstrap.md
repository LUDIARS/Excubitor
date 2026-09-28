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

Use scripts/service-bootstrap.mjs --url <local Ex origin> [--peer <id>] --request <UTF-8 JSON file>. Check with the same command and --operation <returned id> instead of --request. The CLI does not retry POST and contains no peer credentials. HTTP 202 is not completion; the operation must become succeeded. Frontend history labels include the new actions. Bootstrap can also be submitted from an absent-service cell in the WebUI coverage table; data transfer remains API/CLI only.

### Clone / setup / start

Only LUDIARS GitHub repositories and the exact approved source VGA-GLAB/GLAB-Hub, fixed main, ordinary checkouts directly under EXCUBITOR_ARS_ROOT are supported. GLAB-Hub is checked out as GLAB; other repositories retain their repository name. Requests cannot override the destination directory. The GLAB catalog still requires explicit destination-side fragment trust (EXCUBITOR_TRUSTED_FRAGMENT_REPOS=GLAB); accepting its source does not grant catalog execution trust or imply public-service eligibility. Excubitor self-bootstrap is refused. A destination must be writable by the existing Ex service account; root-owned workspaces require a human to precreate each service directory (as with prepare-host.sh). No sudo, chmod of the workspace, clone of Castra, OS package installation or credential provisioning is implied.

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

## WebUIからのインストール

拠点×サービスの担保表で、対象拠点にcatalog登録がないセルは「インストール」を表示する。新鮮なhealth payloadのcatalog由来repositoryが一意に決まる場合だけ使用し、コードから取得元を推測しない。古いpeerとの互換性のためrepositoryは省略可能。未登録・競合・接続不能・stale・対象外リポジトリ・mesh取得元の場合は理由付きで操作不可にする。

対象拠点とサービスの確認後、既存bootstrap APIにrepositoryとstart=trueを送る。受付は完了ではなく、OperationTrackerで取得・setup・起動の結果を表示する。実行中は再送不可。受付応答が失われた場合は自動再送せず拠点履歴の確認を案内する。既存checkoutを自動pull/resetしないAPI契約は維持する。
