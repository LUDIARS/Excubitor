# Node 24 SQLite native addon incompatibility

- Date: 2026-08-23
- Status: fixed in working tree
- Area: dependency/runtime compatibility
- Severity: service installation or startup failure

## Summary

Upgrading the runtime to Node.js 24 exposed a regression in the SQLite native addon dependency. Excubitor still selected `better-sqlite3` 11.x.

## Evidence

`package.json` declared `better-sqlite3` as `^11.8.1`. Native addons built or downloaded for an older Node ABI cannot be reused safely by Node 24.

## Regression Context

The runtime major version was advanced without an equivalent native-addon compatibility gate across repositories.

## Cause

The SQLite binding was pinned below the organization Node 24 baseline. Existing dependency caches can also retain an addon compiled for the previous Node ABI.

## Fix Requirements

- Pin `better-sqlite3` to `13.0.3`.
- Regenerate the lockfile without executing dependency lifecycle scripts.
- Reinstall dependencies under Node 24 before starting the service.

## Verification

No tests were run in this session by policy. Revisor should install dependencies under Node 24 and verify that an in-memory database can be opened and closed before running the repository test suite.

## Follow-up

Dependency caches must include the Node major version and lockfile hash so binaries are not reused across Node upgrades.
