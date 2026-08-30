# Container image security gate

The VPS image is scanned as a complete runtime, not only as an npm project. Release verification uses digest-pinned Syft and Grype images plus `govulncheck` v1.7.0 in binary mode for the Secure MCP Tunnel client.

## Release policy

- Any fixed HIGH or CRITICAL finding fails the image gate. There is no vulnerability-ID allowlist.
- Any Go finding that identifies a vulnerable function symbol in the tunnel binary fails the image gate.
- A package-only `govulncheck` finding is reported as `imported_not_called`; Go documents this shape as an imported package with no vulnerable symbol called. It is not silently discarded.
- The runtime image does not ship the npm CLI or its dependency tree because the service needs only the Node.js executable.
- Scanner reports and the image SBOM are release evidence; they do not contain runtime credentials.

## Hardened tunnel build

PC FileBridge starts from the exact OpenAI tunnel-client v0.0.13 source revision `4b5267f823be0b046bb883aacb51603cfde3a0ea`. The Docker build verifies that commit, applies only explicit dependency upgrades, runs the upstream Go test suite, and then builds the client:

- OpenTelemetry Go: v1.44.0
- `golang.org/x/net`: v0.56.0

The unchanged `cloudflared` executable comes from the digest-pinned official OpenAI v0.0.13 image. Re-run the complete image gate whenever the tunnel source revision, dependency pins, Node.js image, cloudflared image, scanner images, or vulnerability database changes.
