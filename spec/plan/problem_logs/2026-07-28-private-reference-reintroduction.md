# Private reference reintroduction after history repair

- Date: 2026-07-28
- Status: fixed in working tree
- Area: public catalog and startup ordering
- Severity: public repository metadata exposure

## Summary

This is a regression. A previous history repair reduced the configured private-reference audit to
zero, but a branch based on the older history was merged afterward and restored 11 matching lines
to the public default branch.

## Evidence

- The post-merge default branch contained five matches in `catalog/services.yaml` and
  `src/catalog/tier.test.ts`.
- Six additional matches remained in `spec/plan/design.md`, `src/launch/order.ts`, and
  `src/launch/order.test.ts`.
- The affected service already has a complete, tracked `excubitor.catalog.yaml` in its owning
  repository, so its duplicate base-catalog entry is unnecessary.

## Regression Context

PR #84 introduced per-repository catalog fragments on 2026-07-18. PR #85 then removed eight
private or obsolete services from the public base catalog. The affected service fragment was added
to its owning repository on 2026-07-22, but the duplicate base entry was not removed. A later merge
from pre-repair history restored identifiers that the audit had already removed.

## Cause

The public base catalog and the owning repository fragment were allowed to define the same service
under different identifiers. Startup ordering also encoded one private project identifier instead
of deriving the tier from the public `uses_corpus` capability.

## Fix Requirements

- Keep the service definition only in its owning repository fragment.
- Derive startup tier 3 from `uses_corpus` rather than a project-specific identifier.
- Remove all configured private-reference matches from the new public root snapshot.
- Do not merge or cherry-pick commits from the archived history into the replacement repository.

## Verification

- Re-run the configured private-reference audit against the replacement repository.
- Confirm the base catalog no longer duplicates the owning repository fragment.
- Confirm a `uses_corpus` service still resolves to startup tier 3.
- Automated tests were not executed in this session per the session policy.

## Follow-up

Run the same leak audit over the four replacement repositories after the Excubitor replacement is
complete.
