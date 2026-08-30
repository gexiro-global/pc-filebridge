# Release verification

Release integrity has three independent layers: SHA-256 checksums, GitHub artifact provenance, and a functional receiver test.

## 1. Verify checksums

Download all four assets into one empty directory. `SHA256SUMS` contains lowercase SHA-256 hashes and basename-only filenames for exactly the runtime package, source archive, and CycloneDX SBOM.

On Linux or macOS:

```bash
sha256sum -c SHA256SUMS
```

On Windows, use the PowerShell verification block in the project README.

## 2. Verify provenance

With GitHub CLI authenticated:

```bash
gh attestation verify pc-filebridge-vX.Y.Z-runtime-npm.tgz --repo gexiro-global/pc-filebridge
gh attestation verify pc-filebridge-vX.Y.Z-source.tar.gz --repo gexiro-global/pc-filebridge
gh attestation verify pc-filebridge-vX.Y.Z-sbom.cdx.json --repo gexiro-global/pc-filebridge
gh attestation verify SHA256SUMS --repo gexiro-global/pc-filebridge
```

The subject digest must match the downloaded file and the workflow source must be this repository.

## 3. Inspect and test

Inspect the source archive and SBOM before execution. Install the runtime archive in an empty synthetic project with `npm install --ignore-scripts <archive>`. Configure only a temporary test root and run `node node_modules/pc-filebridge/scripts/mcp-smoke.mjs`.

Expected result:

```text
MCP_SMOKE_PASS tools=7 forbidden_mutations=0 list_roots=ok
```

A matching hash alone is not proof that the package installs or preserves the MCP security invariants. The release is accepted only after all four public assets are downloaded again, basename-only checksums pass, all four provenance subjects match, and the runtime archive passes this clean-room receiver simulation.
