## Summary

Describe the change and why it is needed.

## Security-boundary impact

Describe any effect on configured roots, path containment, sensitive-name filtering, reads, create-only writes, MCP tools, credentials, or remote transport. Write `None` only after checking each boundary.

## Verification

- [ ] `npm run check`
- [ ] `npm pack --dry-run --ignore-scripts`
- [ ] Added or updated negative tests for policy/tool changes
- [ ] Tested with synthetic data only
- [ ] No credentials, private paths, tunnel IDs, app IDs, telemetry, production endpoints, logs, or real user files added
- [ ] No overwrite, append, patch, rename, move, link, delete, remove, or unlink capability added
- [ ] Linux CI, Windows security checks, CodeQL, and dependency review pass

## Release impact

State whether `CHANGELOG.md`, release documentation, or version fields must change.
