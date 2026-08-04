# Central Service Catalog Regression

- Date: 2026-08-04
- Status: fixed in working tree
- Area: catalog ownership and lifecycle resolution
- Severity: high; stale central definitions can start or operate the wrong service configuration

## Summary

This is a regression against the service-owned catalog design. Excubitor still loaded
`catalog/services.yaml` as a higher-priority base even though every service is meant to own its
`excubitor.catalog.yaml`. That made Excubitor, rather than the service repository, the effective
owner and allowed stale central entries to mask missing owner catalogs.

## Evidence

- `src/catalog/loader.ts#loadCatalog` read `catalog/services.yaml`, then let its service codes win
  over repository-owned sources.
- `src/index.ts` and `src/local-control/catalog-runtime.ts` both supplied the central path.
- `catalog/FRAGMENTS.md` and `spec/plan/design.md` still described the central file as source of truth.
- Git commit `534defe` (2026-07-18) introduced per-repository aggregation and records the neco
  requirement that aggregate data be cached, but retained the central catalog as a higher source.
- Session log `E:/Document/Ars/session-logs/2026-08-04.md` records that auto-catalog was removed in
  `d66a217`, while the base read remained unfinished as Memoria task #738. It also records removal
  of an obsolete `project-excubitor-catalog-fragments.md` memory that contradicted the new policy.

## Regression Context

The service-owned source, content-hash cache, source-level last-known-good retention, and polling
fallback had already been implemented and hardened. Removal stopped after the generated catalog,
leaving the older handwritten base and its watcher in the runtime path.

## Cause

The distributed source was added incrementally as a lower-priority compatibility layer. Later work
removed the generated source but did not remove the original base loader, editor, watcher, Vite host
reader, and current-spec references together.

## Fix Requirements

- Resolve services exclusively from trusted owner repositories' `excubitor.catalog.yaml` files.
- Do not fall back to a central file, DB snapshot, or scan output when an owner catalog is absent.
- Reject duplicate ownership for a service code instead of silently selecting one source.
- Isolate invalid or temporarily unreadable sources and retain the existing source-level
  last-known-good cache.
- Keep Excubitor-only monitoring/retention/log policy separate from service definitions.
- Point metadata editing at the owning repository's file, and stop deriving Vite allowed hosts from
  a catalog file at all (they come from `EXCUBITOR_ALLOWED_HOSTS` / `LUDIARS_ALLOWED_HOSTS`).
- Decide catalog trust per owning repository (LUDIARS origin or explicit allowlist), not per
  discovery root: `EXCUBITOR_ARS_ROOT` is optional, so a root-level gate would empty the catalog on
  the default layout where the workspace root is the parent of the Excubitor checkout.
- Missing owner catalogs may make start/restart fail; this is intentional and observable.

## Verification

Expected regression coverage:

- runtime config rejects a top-level `services` key;
- an owner catalog that declares any top-level key besides `services` is isolated as a shape issue;
- duplicate owner codes are omitted with source paths in a warning;
- invalid/untrusted owner files do not suppress unrelated valid services;
- trusted owner repositories still load when the workspace root came from the implicit default;
- runtime/config and fragment watchers reload their respective sources;
- no production path references `catalog/services.yaml`.

Per session policy, unit, integration, runtime, and startup tests were not executed.

## Follow-up

Services without an owner catalog are handled after they fail an attempted start/restart. The
central catalog must not be restored as a compatibility fallback during that follow-up.
