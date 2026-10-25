# Service security reports {#SPEC-EX-SECURITY-REPORTS}

Requested by neco: detailed dependencies, communications and vulnerability reports
for running services, persisted in Excubitor and readable from its UI.

The local service detail displays the latest report, its observation/recording times,
author, scope, and four separate sections: dependencies, communications,
vulnerabilities, coverage. Each retains reviewed/findings/unverified status. Missing,
failed, old or incomplete reports never become a safety assurance. Text is rendered
as escaped React text, with no HTML/Markdown interpretation or automatic external links.

GET /api/v1/services/:code/security-report returns {report:null} when absent.
POST at the same path accepts the strict reportInput schema and returns the recorded
report with generated id/service/recordedAt. Payloads are capped at 1 MiB, section
detail at 200k characters. Unknown services and unsafe codes are rejected. These
management routes inherit localBrowserGuard and no-store; they are NOT mounted on
the public/federation/DMZ router. Report writes confer no lifecycle authority.

Records are local append-only JSON under data/security-reports/<validated-code>/.
They are operational data, not source-controlled inventories. Retain raw secrets,
tokens, environment values, URL queries and payloads outside reports. Submitters
must sanitize evidence; this API cannot infer every secret from free text.
No background audit, installation, dependency update, outbound query, communication
block or process restart is triggered by reading or writing a report.

Dependencies need lockfile and installed-version distinction, direct/transitive and
runtime/development scope, and advisory source/date when queried. Source URL literals
are candidates rather than proof of communication. Runtime connections are a bounded
snapshot and do not prove necessity or absence of covert/short-lived traffic.
When external advisory lookup is not authorized, report it as unverified explicitly.

Regression coverage: persistence across store instances, unknown service, absent
report, malformed data, traversal and browser-origin rejection. Delegated Revisor
execution is required; local tests have not been run by this session.
