# Domain Taxonomy: excubitor

This taxonomy registers the Excubitor codebase for Anatomia domain detection.
It is intentionally path-based and does not move code or add architecture gates.
Where a central file uses named glue functions, the ontology adds name-scoped
membership filters; anonymous inline route handlers remain assigned by their
own router/module files rather than by line ranges.

## service-startup

Service lifecycle control: backend bootstrap, safe mode, process launch, adoption,
stop/restart, and startup preflight.

- **backend-bootstrap**: `src/server.ts`, `src/index.ts`, `src/service-runner.ts`,
  `src/startup/*`, safe-mode support, build version/exec helpers, root package
  metadata, and `start-excubitor.bat`.
- **operator-ui-shell**: frontend boot, dashboard routing, shared API client,
  Vite config, and frontend package/TS config.
- **service-control**: `src/control/*`, process launch/reconcile helpers, and
  launch profile/preflight/orchestration routes, including the Monitor start/stop
  operator surface.

## cross-service-logging

Cross-service log ingestion, recent-log queries, live SSE streams, Vestigium reads,
and shared log output.

- **log-ingestion**: `src/log/*`.
- **diagnostic-logging**: shared structured logger.
- **logging-ui**: Logs page and reusable log drawer.

## federation

Node-to-node federation, remote peer management, remote service proxying, and
Corpus hub publication.

- **peer-federation**: `src/federation/*`.
- **corpus-hub**: `src/hub/*`.
- **agent-and-peer-ui**: MCP server bridge and Federation page.

## performance-monitoring

Runtime health, port conflict, memory, CPU, WSL, docker, and liveness monitoring.

- **memory-performance**: memory/CPU collection loops, leak detection, budget
  checks, and memory API routes.
- **health-scanning**: port, docker, git, package, host process, and health-state
  scanners.
- **monitoring-ui**: Monitor/Memory pages.

## env-management-and-injection

Environment variable resolution, topology env generation, Infisical mapping,
secret agent resolution, and domain-root settings.

- **secret-config**: `src/secrets/*`.
- **env-injection**: process env injection/topology/startup validation, roots,
  catalog config surfaces, `.mcp.json` reconciliation, and catalog YAML.
  `src/index.ts#reloadCatalog` is also assigned here as central catalog reload
  glue.
- **config-ui**: Catalog and Config pages for domain-root, Infisical, and
  service-env editing.

## error-management

Error detection, triage APIs, emergency actions, auto-fix run records, and
operational error persistence.

- **error-detection**: log error detector and DB schema/client/storage paths.
- **emergency-ops**: emergency remediation helpers.
- **triage-api-glue**: `src/index.ts#resolveTaskAndService` because the central
  error-task routes still hold this helper.
- **triage-ui**: Errors page and operator triage queue.

## task-generation

Generated operational work: auto-fix, investigation, review surfaces, update
application, release build orchestration, and service discovery.

- **auto-fix-investigation**: `src/auto_fix/*` and `src/reviews/*`.
- **delivery-tasks**: update, release, and discovery route/task surfaces.
- **task-api-glue**: `src/index.ts#resolveTaskAndService` for generated
  auto-fix/investigation dispatch from the central routes.
- **review-ui**: Reviews page for generated review work.

## test-environment

Automated tests, test fixtures, and local specs used to verify Excubitor behavior.

- **unit-and-api-tests**: Vitest files under `src`.
- **spec-and-review-artifacts**: `spec/*` and `review/*` context artifacts.

## measurement

Instrumentation and derived metrics: HTTP/startup timing, diagnostic event
measurement, liveness/downtime calculations, memory sample storage, and metric
visualizations.

- **request-and-diagnostic-measurement**: request timing, startup/runtime
  diagnostics, function-metric proxy helpers, and tunable timing thresholds.
- **liveness-measurement**: availability samples, uptime ratios, downtime windows,
  and liveness-derived measurements.
- **memory-metric-measurement**: metric endpoint ingestion, normalized memory
  metric shape, and persisted sample series.
- **metric-visualization**: metric graph, sparkline, and function-metric UI
  helpers for measured series.
