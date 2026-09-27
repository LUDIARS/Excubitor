# AWS as a shared Excubitor site {#SPEC-EX-AWS-SITE}

AWS is a regular federation peer, hosting multiple independently managed services.
The initial service is MemoriaPlugin distribution (`memoriaplugin-distribution`).
Memoria downloads its plugin artifacts and executes them locally. Tabula is a future
placement candidate, not a service to deploy as part of this change.

## Reused implementation

- Site registration and mutual authentication: existing Federation UI and peer API.
- Git update/install/build/deploy: `src/federation/operations/service-operation.ts`.
  Production deployments explicitly install development dependencies because builds
  require compilers and bundlers even under `NODE_ENV=production`.
- Lifecycle: the destination site's persistent supervisor, using its normal main checkout.
- Liveness: destination health loop, peer poller and cached federation mesh. Unknown,
  unreachable and stale observations remain distinct. Requests never add live probes.
- Operation history/status: existing asynchronous operation IDs and UI/MCP tools.

No AWS API credentials, infrastructure provisioning, SSH execution or second deployment
engine are introduced. `deploy` preserves the existing contract: fetch/install/build,
then restart only if already running. A stopped service needs a separate `start` request.

## Site placement tool

`excubitor_site_coverage` exposes the existing coverage API with `action=list|set`.
For `set`, `code` and `covered` are mandatory; null restores the catalog default.
The tool always acts on the Ex backend it is connected to. It cannot silently target
another peer and never starts or stops a service. Changes live in the site's existing
coverage store; shared service catalogs remain repository-owned.

## First deployment handoff

1. Prepare the AWS host with normal main checkouts of Excubitor and MemoriaPlugin,
   Node and dependencies. Install the existing persistent supervisor through the
   normal operator procedure. No worktree or copied checkout is a runtime target.
2. Configure the Ex federation listener on the private mesh address and mutually
   register it with existing sites. Keep the administrative listener loopback-only.
3. Discover/trust MemoriaPlugin's owned `excubitor.catalog.yaml`. Use coverage settings
   to assign the distribution service to AWS and opt out on development sites.
4. Configure the distribution endpoint using MemoriaPlugin's `deploy/excubitor-site.md`.
   Select the actual hostname and AWS connection separately; this change does not invent them.
5. Use `excubitor_list_peers` to obtain the AWS peer ID, then
   `excubitor_request_operation {peer_id, target:"memoriaplugin-distribution", action:"deploy"}`.
   Track the returned ID with `excubitor_operation_status`; start separately if stopped.
6. Inspect `excubitor_federation_mesh` for site/service health and freshness. Successful
   deployment operation completion does not establish public HTTPS download availability.

## Acceptance

The same workflow must operate other eligible services through their own catalogs;
there is no MemoriaPlugin special case in the deployment runner. Invalid coverage
inputs must fail without changing placement. Build failures must stop before restart;
production environment builds must retain dev tooling. Runtime acceptance additionally
checks anonymous catalog/archive download, integrity and Memoria installation, then
continued installed-plugin operation when the distribution site is unavailable.

This implementation session has no authorization to execute tests, deploy, restart,
provision AWS resources, merge or publish. Those acceptance steps remain pending.
