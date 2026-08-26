# Contributing

Contributions are welcome when they preserve create-only writes, bounded reads, path containment, and fail-closed configuration.

1. Use temporary directories and synthetic data in tests.
2. Run `npm run check` and `npm pack --dry-run --ignore-scripts`.
3. Add negative tests for every path-policy or tool-schema change.
4. Document every new tool, permission, environment variable, and security boundary.
5. Never add real credentials, private paths, tunnel IDs, app IDs, telemetry, or production endpoints.
6. Do not introduce overwrite, append, patch, rename, move, link, delete, remove, or unlink capabilities under an indirect name.
7. Open changes through a pull request and keep all required Linux, Windows, CodeQL, and dependency-review checks green.
8. Do not move dependency upgrades into an unrelated security or release patch.

Pull requests must use the repository template and describe the security-boundary impact. Releases follow [docs/RELEASE_PROCESS.md](docs/RELEASE_PROCESS.md); maintainers never upload hand-built artifacts.

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
