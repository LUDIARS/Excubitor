# Terminal connections

## SPEC-TERMINAL-CONNECTIONS

2026-10-17 neco: generalize terminal connections in Excubitor. Configure a server display name,
hostname/IP, port, network scope and password or SSH-key authentication. Password authentication
is allowed only inside LAN/VPN; external connections require keys. Both methods use SSH transport.

The local management UI has a Terminal tab with profile CRUD, write-only credentials, host-key
discovery/verification and a bounded noninteractive command console. `serverName` is a display
label, `host` is the network endpoint, and the login username is independent of both.
Each command uses an independent SSH exec channel. Interactive terminals, PTY, persistent shell
state, file transfer and unattended migration are outside this contract. Existing Ex service-control
operations remain the supported path for service lifecycle actions.

### Persistence and secrets

`terminal-connections.json` next to Vault stores only validated version-1 profile metadata.
Writes use a temporary file and rename. Credential values are stored using the existing shared
Vault encryption and OS-protected key; names are scoped to the profile UUID:
`TERMINAL_<UUID without hyphens, uppercase>_{USERNAME,PASSWORD,PRIVATE_KEY,PASSPHRASE}`.
Only the selected authentication method is resolved. No agent, keyboard-interactive or password
fallback is enabled. Empty UI fields preserve existing credentials; the API can clear the key
passphrase with an explicit empty string. Profile deletion retains Vault entries, explicitly reported
in the UI/API; operators can remove retained entries in the Vault tab. Values are never returned by
profile reads, or written to command-line arguments, profile files, request logs or SSH error logs.

### Network and identity boundary

For private profiles all resolved addresses must be RFC1918, 100.64.0.0/10 (Tailscale/CGNAT), or
IPv6 ULA fc00::/7. This is an address-scope policy, not proof of VPN membership; operators must
choose the actual LAN/VPN endpoint. Loopback, link-local, multicast, unspecified and public
addresses are not private targets. A hostname returning both public and private addresses is rejected.
The numeric IP selected from that validated lookup is pinned for the actual SSH connection, so
there is no second DNS lookup between validation and authentication. Every execution revalidates.
An external profile cannot select password, including through direct API input.

All profiles require a SHA256 host-key fingerprint. Discovery rejects the key before authentication
and returns the fingerprint without sending credentials. The operator compares it with trusted
server information and saves it explicitly. Execution refuses changed keys before authentication.

Terminal routes are mounted only on the loopback management server, not the DMZ/federation
listener. They require a loopback Host, matching Origin when present, and the custom
`x-excubitor-terminal: 1` header. External/cross-origin MCP HTTP requests do not receive terminal
tools, preventing the MCP proxy from bypassing the terminal request boundary. Stdio MCP is a
local trusted operator interface. No new public terminal endpoint is added.

### API / MCP

- GET `/api/v1/terminal/profiles`: metadata and Vault key names, never values.
- PUT `/api/v1/terminal/profiles/:id`: `{profile, credentials?}`; validates UUID, host, port,
  network/auth combination, pinned host key, and private DNS scope before writes.
- DELETE `/api/v1/terminal/profiles/:id`: remove metadata, retain Vault entries.
- POST `/api/v1/terminal/inspect`: `{host, port, network, auth}`; discover host fingerprint only.
- POST `/api/v1/terminal/profiles/:id/exec`: `{command, timeoutMs?}`; return operation ID,
  stdout/stderr, exit code and exit signal. No command or output is persisted.
- MCP `excubitor_terminal_connections` and `excubitor_terminal_exec` reuse these APIs.

Maximum four active SSH requests per backend. Connect timeout 15 seconds, command default
30 seconds / maximum 120 seconds, combined output limit 256 KiB. Socket/channel/timer/abort
listeners are closed on success, failure, cancellation and limits. Unknown SSH errors are redacted
to fixed error codes. Disconnect/timeout is not evidence of remote cancellation; clients must inspect
the remote state before retrying. Remote commands are never automatically retried.

### Verification

Policy regressions cover public/private/mixed DNS, IPv4-mapped IPv6, external password rejection,
pinning, request origins, Vault encryption and profile persistence. Transport regressions cover
host-key mismatch, auth selection, output limits and resource cleanup. Tests belong to the review
workflow; implementation sessions do not run tests or start services without explicit authorization.
SSH transport uses ssh2 1.17.0 (MIT; https://github.com/mscdex/ssh2).
