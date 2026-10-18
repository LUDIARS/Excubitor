# Service port provenance

## SPEC-EX-PORT-PROVENANCE

`/api/v1/services` and `/api/v1/services/:code` use the current catalog's declared port for both `port` and port-owner classification. Historical `service_instances.port` is published separately as `observed_port`; it must not override an explicitly declared endpoint. `port_source` identifies catalog/observation/none/invalid_catalog and `port_mismatch` identifies two valid but differing values.

When a catalog has no port property, legacy observations remain usable. Explicit null means no declared port. Invalid declared values do not silently fall back to an old port. This read-model fix does not rewrite process observations, infer a PID, change lifecycle state or make an unmanaged process trusted. No extra network or process probes are performed in a request.

Incident: Actio catalog declared 17880 while API ownership diagnostics examined historical 3000. Health 200 was incorrectly paired with a free-port diagnosis for a different endpoint. Related Actio report: `f91f3088-9be8-4d63-82cf-729a7a058e93`. The earlier transient stopped state is a separate lifecycle observation; fixing port provenance does not claim to resolve its trigger.

Regression coverage: stale observation, absent observation, absent declaration, explicit null, invalid declaration; API list/detail must show and classify the same effective port. Tests are authored for review; session execution requires separate explicit authorization. Deployment/restart has not been performed by this change.
