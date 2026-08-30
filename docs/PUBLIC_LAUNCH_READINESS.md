# Public launch readiness

A release is launch-ready only when all gates below are satisfied for the exact tagged commit.

- [ ] `main` is protected; required checks include Linux CI, Windows security checks, CodeQL, and dependency review.
- [ ] Force-push and branch deletion are disabled and administrators are subject to protection.
- [ ] GitHub vulnerability alerts, automated security fixes, private vulnerability reporting, secret scanning, and push protection are enabled.
- [ ] Tracked-file secret scan, typecheck, policy tests, build, MCP smoke, package dry-run, SBOM validation, and production dependency audit pass.
- [ ] The digest-pinned VPS image builds, exposes exactly seven tools, preserves create-only bytes, fails closed without secrets, and its Compose model validates.
- [ ] Windows CI creates and rejects a real junction and covers alternate data streams and reserved names without a silent skip.
- [ ] CodeQL, Dependabot, and secret-scanning have no unresolved release-blocking alert.
- [ ] Tag matches all version fields and points to a reviewed commit on `main`.
- [ ] Receiver verification passes for runtime package, source archive, SBOM, and basename-only `SHA256SUMS`.
- [ ] GitHub build-provenance attestations exist for every release asset.
- [ ] Release tag is immutable and release assets are not replaced after publication.

Runtime health, connector availability, and successful local tests do not substitute for these release gates.
