# Server installation candidates

## Candidate policy {#SPEC-SERVICE-INSTALL-CANDIDATES}

The coverage matrix defaults to server candidates with the issue-only filter off. Previously healthy services such as Actio were hidden by the initial issue filter. Name, service code, project code and repository are searchable. Operators can clear the server filter to retain access to all monitoring entries.

The service catalog remains the repository authority. No repository is invented from a code. Candidate classification does not promise a bootstrap manifest or setup script exists; the destination verifies the existing service-owned bootstrap contract before setup/start.

Native app/android runtimes and local-app tier are excluded, including node-based desktop/game tools. Personal-tier entries are excluded as PC-owned tools except explicitly supported standalone services Actio, Actio Web and Tabula. Memoria entries stay excluded while standalone Tabula remains eligible. Browser-only codes ending in `-web` or `-client` are excluded unless explicitly allowlisted, and remaining known game-service codes are excluded in `src/bootstrap/candidate.ts` because runtime/tier alone do not identify them. This small classification list is not a repository or launch catalog and must be maintained when new game services are registered.

The optional `server_install_candidate` health field is computed from the in-memory catalog without filesystem scans. The initiating headquarters catalog owns candidate classification; peer-only services cannot add install candidates through their health reports. Repository agreement checks still reject conflicting clone sources. Missing headquarters classification is unknown and cannot enable installation. Old peers stay protocol-compatible. This implements headquarters-driven placement from its WebUI, not a new automatic configuration distribution protocol or globally enforced HQ identity. This is a UI candidate filter, not a replacement for API authorization or bootstrap validation.
