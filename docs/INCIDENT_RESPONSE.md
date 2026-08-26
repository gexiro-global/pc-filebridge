# Incident response

Treat a leaked runtime key, unexpected root exposure, unrecognized tunnel connection, secret-scanning alert, release-integrity failure, or bypass of the create-only/path-containment policy as a security incident.

## Immediate containment

1. Stop the PC FileBridge tunnel runtime without deleting user files.
2. Revoke the dedicated tunnel/runtime credential and remove it from scheduled-task inputs.
3. Preserve redacted logs, release hashes, configuration metadata, process identity, and timestamps. Never publish file contents or credential values.
4. Disable the affected connector until the root scope and runtime identity are understood.

## Investigation and recovery

1. Compare the installed release and SBOM against `SHA256SUMS` and GitHub provenance.
2. Audit configured roots, full-drive opt-in, scheduled tasks, tunnel identity, package version, and open GitHub security alerts.
3. Reproduce with synthetic files and narrow roots. Do not test with real secrets.
4. Patch through a reviewed pull request, rerun Linux and Windows gates, issue a new immutable release, and rotate the runtime credential before reconnecting.

Report product vulnerabilities privately through [GitHub Security Advisories](https://github.com/gexiro-global/pc-filebridge/security/advisories/new). Do not place sensitive incident material in a public issue.
