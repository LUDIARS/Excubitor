# Service overview review evidence

Revisor #1994 found a first-snapshot race (HTTP integration expected 200, got 503). The payload cache now primes during boot, outside the HTTP path. First collection failure still returns snapshot_pending; periodic refresh retries.

## Reachability advisories

- App is rendered by frontend/src/main.tsx.
- changed is registered as App's hashchange listener and removed on cleanup.
- Overview is rendered by App when the overview tab is active.
- ServiceDetail is rendered by Overview for a resolved site/project route.
- ServiceSettings is rendered by ServiceDetail for local components.
- cachedAuthenticationPeers is the default peers callback of requireMutualPeer.

These six references cross JSX/event/callback boundaries; none is dead code. The analysis warning is documented rather than suppressed.

## Coupling

The background overview collector composes launch read models, scanner health cache and federation peer cache at the application layer. HTTP handlers read only published data. Frontend uses import type for the transport model, adding no backend runtime dependency to the browser bundle. Existing domain heuristics classify generic Component/State symbols into overlapping domains; numeric coupling alone does not establish a cycle.

## Validation

Backend/frontend type checks, production Vite build and 12 focused cases passed. Revisor's full suite passed 851 cases, skipped one and found the readiness failure above. The fix awaits Revisor revalidation. No failing check is waived.
