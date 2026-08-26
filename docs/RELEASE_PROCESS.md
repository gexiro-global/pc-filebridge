# Release process

PC FileBridge releases are built from the canonical public repository, never from an operator runtime or a secret-bearing installation directory.

## Preconditions

1. Start from a clean, reviewed commit on the protected `main` branch.
2. Set one semantic version consistently in `package.json`, `package-lock.json`, `.codex-plugin/plugin.json`, and the MCP smoke client.
3. Update `CHANGELOG.md` and complete [Public launch readiness](PUBLIC_LAUNCH_READINESS.md).
4. Confirm Linux CI, mandatory Windows security checks, CodeQL, dependency review, tracked-file secret scan, production dependency audit, and MCP smoke are green.
5. Confirm the source contains no credentials, private endpoints, operator identifiers, private configuration, logs, or real user files.

## Automated workflow

Push the matching `vX.Y.Z` tag only after the commit is on `main`. The release workflow rejects a mismatched version, a tag outside `main`, a failing source check, a malformed SBOM, non-basename checksum entries, or an artifact that cannot be installed and smoke-tested as a fresh receiver.

The workflow publishes exactly:

- `pc-filebridge-vX.Y.Z-runtime-npm.tgz`
- `pc-filebridge-vX.Y.Z-source.tar.gz`
- `pc-filebridge-vX.Y.Z-sbom.cdx.json`
- `SHA256SUMS`

It re-verifies the downloaded workflow artifact, creates build-provenance attestations, and then creates the GitHub release. Maintainers do not upload replacement files manually. Release tags are immutable.

## Receiver verification

Follow [RELEASE_VERIFICATION.md](RELEASE_VERIFICATION.md) in a new empty directory using only the downloaded assets. Never test a public release with a production root configuration, runtime key, private tunnel identifier, or real user file.
