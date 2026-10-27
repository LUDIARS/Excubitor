# Existing public origin adoption

Extends SPEC-EX-INTRUSION-MONITOR for the authorized AWS/HQ activation. Existing
legacy services, the Access-protected Ex management hostname and one CloudFront
HTTPS origin must remain usable without inventing catalog ownership or silently
bypassing the original origin restrictions.

An operator can explicitly opt a route into adoption with its tunnel ID and SHA256
of the original ingress rule plus global originRequest. First startup reads CF,
checks exact hostname/path, origin, forwarded Host and hash, then durably records
the approved route fingerprint and hashes of the original, gateway-bound and
blocked forms. Later startup accepts only those forms and the same fingerprint.
Changed Access policy, origin, path or unrelated origin options fail closed.
The approval receipt is separate from the incident database, so controlled
incident recovery does not erase origin provenance. No API clears approvals.

The Ex management origin additionally requires cloudflared Access validation with
required=true and nonempty audience/team configuration. Gateway/federation ports
remain forbidden. Private IPv4 origins retain their strict parser. HTTPS support
is limited to exact *.cloudfront.net distribution origins and requires adoption;
TLS certificate verification remains enabled. No request chooses its destination.

Creating data/intrusion-config.json is an explicit local opt-in; the existing env
path overrides it. Missing default file means unconfigured, whereas unreadable or
invalid configuration is an error. Configuration alone never repoints CF routes.

Acceptance: reject missing/stale source proof, changed config/Access, unknown
gateway receipt, management without Access, federation/self recursion; preserve
original paths/Host/Access through adoption, restart, and blocked-state recovery.
Tests use fake CF and isolated approval files; live activation remains separate.

Communication: configured adoption performs authenticated CF GETs at startup, with
bounded timeout, using existing Ex credentials. No new CF write path is added.
Forwarding sends the same client stream to the approved origin; CloudFront HTTPS
uses Node TLS verification. Unconfigured startup performs none of this. Receipt
files contain only hashes, no credentials. No dependency or install hook is added.
