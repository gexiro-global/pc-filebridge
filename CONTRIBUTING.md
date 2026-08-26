# Contributing

Contributions are welcome when they preserve create-only writes, bounded reads, path containment, and fail-closed configuration.

1. Use temporary directories and synthetic data in tests.
2. Run `npm run check` and `npm pack --dry-run --ignore-scripts`.
3. Add negative tests for every path-policy or tool-schema change.
4. Document every new tool, permission, environment variable, and security boundary.
5. Never add real credentials, private paths, tunnel IDs, app IDs, telemetry, or production endpoints.
6. Do not introduce overwrite, append, patch, rename, move, link, delete, remove, or unlink capabilities under an indirect name.

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
