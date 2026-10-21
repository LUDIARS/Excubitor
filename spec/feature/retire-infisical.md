# Retire Infisical operational integration

Task: actio:dbede97f-5185-4770-97cd-48a727da9525.

Remove the retired external secret provider's client, import endpoints, identity
settings and startup environment injection. Vault remains the sole runtime source.
Do not delete or rewrite stored Vault entries, bindings, encrypted legacy config,
or secret-agent credentials. Preserve shared/project precedence and fail closed
when a legacy declaration still requires secrets that have not migrated to Vault.

Boundary: secret configuration, Vault import adapter, supervisor bootstrap and
the corresponding frontend controls. Retired HTTP routes return not found;
general settings move to `/api/v1/config`. Existing notification, domain-root,
runtime-config, Cloudflare settings and Vault management remain available.

Verification must cover removed routes, surviving configuration and Vault routes,
secret-agent authorization, project/shared precedence and legacy missing-secret
rejection. Unit tests and service operations are not executed without permission.
Rollback is a code revert; this change performs no stored-secret migration.

## Validation record

Frontend `tsc --noEmit -p frontend/tsconfig.json` passed. Backend `tsc --noEmit`
reports four missing `@ludiars/log-weaver` declarations in federation/security;
the same four diagnostics occur on unchanged local main. Backend validation is
therefore blocked by existing dependency preparation, not reported as passing.
Regression tests were updated but not executed. No service was started/restarted.
