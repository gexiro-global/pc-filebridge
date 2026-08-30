# Changelog

## 0.2.2 - 2026-08-30

- Fixed Windows autostart durability: the tunnel task now has no finite execution limit and is not stopped by battery or idle transitions.
- Added a Windows PowerShell 5.1-compatible role-bound auto-volume task installer with optional isolated runtime state.
- Added a regression contract for the required long-running Scheduled Task settings.

## 0.2.1 - 2026-08-30

- Derive a stable, opaque volume id from host, disk, partition, volume, and serial identity; drive-letter, label, health, filesystem, and bus changes do not change that id.
- Restrict automatic discovery to healthy online NTFS volumes on internal NVMe, SATA, SAS, RAID, Storage Spaces, or SCM buses.
- Require an ACL-protected, explicit operator approval for File Backed Virtual, USB, SD, MMC, 1394, and removable volumes; network, optical, unknown, ReFS, unhealthy, and incomplete or colliding identities fail closed.
- Expose additive non-secret topology metadata through `list_roots` while preserving the exact seven-tool MCP contract.
- Add candidate-only discovery plus approval and revocation helpers.
- Require three matching topology snapshots, a real local MCP probe, transactional last-known-good promotion, rejected-topology suppression, crash-window recovery, and a role-scoped singleton monitor.
- Add Windows regression coverage for stable identity, approval ACLs, identity collisions, runtime rollback, all six crash windows, and singleton enforcement.
- Publish the runtime version through OCI metadata, the container environment, and successful healthcheck output.
- Fix approval-registry ACL validation under PowerShell 7 and execute the discovery regression suite under both Windows PowerShell and PowerShell 7 in CI.

## 0.2.0 - 2026-08-30

- Separate PC-local, laptop-local, and infrastructure access into distinct tunnel roles, runtime aliases, and root-id namespaces.
- Add fail-closed tunnel metadata verification so a role refuses a tunnel created for another backend.
- Add an explicit `armed/locked` operator gate for local ChatGPT connectors while keeping local Codex stdio independent.
- Add PC C/D, laptop C/optional D, and infrastructure root configuration examples without mirroring complete local drives to the VPS.
- Pin the container deployment to the infrastructure tunnel role and require its exact operator-visible tunnel name.
- Add a machine-checked role contract, exact root-path enforcement, container configuration negative tests, split-brain recovery procedure, and truthful device availability documentation.
- Add release-wide version consistency checks, exclude private VPS records from the public runtime package, and refresh production dependencies.
- Add fail-closed Windows volume discovery with bus/filesystem/health/identity policy, automatic role-bound root generation, and a singleton monitor that transactionally reapplies only the affected runtime and rolls back failed topology changes to a private last-known-good configuration.

## 0.1.3 - 2026-08-28

- Update the hardened VPS image to digest-pinned Node.js 24.20.0 LTS, remove the unused npm CLI from the runtime layer, and refresh current MCP, type, build, and test dependencies.
- Replace the local-only readiness probe with a tunnel-aware healthcheck that requires a recent successful command poll.
- Default tunnel logs to warning level and add bounded local log rotation in the Compose deployment.
- Add an optional host-managed CA overlay for Linux environments with TLS inspection without disabling certificate verification.
- Rebuild the exact OpenAI tunnel-client v0.0.13 source revision with fixed OpenTelemetry Go and `x/net` dependencies, after running the upstream Go test suite.
- Add a digest-pinned Syft, Grype, and `govulncheck` image gate with no HIGH/CRITICAL vulnerability allowlist.
- Refresh pinned GitHub Actions used by CodeQL and release artifact download.

## 0.1.2 - 2026-08-27

- Resolve every existing path component to its filesystem-stored name by exact BigInt file identity before authorization.
- Block Windows 8.3 and other alternate spellings while continuing to allow case-only Windows spelling differences.
- Re-apply sensitive-name policy to stored directory entries and fail closed for missing, zero, unstable, or ambiguous identity.
- Block multiply linked regular files and add parent/file identity checks around create-only operations.
- Add a non-skippable real Windows 8.3 fixture covering stat, list, read, search, and create-parent paths.
- Require Ubuntu and Windows CI on Node.js 22 and 24, production-license review, package-content review, SBOM validation, and clean-room receiver simulation.
- Add an always-on hardened VPS deployment with digest-pinned Node and OpenAI tunnel images, external data/secret volumes, non-root execution, a read-only root filesystem, no published ports, and container create-only/fail-closed CI.

## 0.1.1 - 2026-08-26

- Block PuTTY `.ppk`, Java keystores, additional private-key formats, and SSH `id_*` private-key variants.
- Add regression tests for direct access, directory listing, and filename search filtering.
- Add fail-closed public configuration, a tracked-file secret scan, CI, CodeQL, threat model, privacy notice, and Apache-2.0 release metadata.
- Make full-drive tunnel mode an explicit opt-in instead of the default.
- Add mandatory Windows junction, reparse-point, alternate-data-stream, and reserved-name coverage.
- Add dependency review, branch-protection-ready checks, receiver-side artifact verification, CycloneDX SBOM, basename-only SHA-256 checksums, and build provenance for tagged releases.
- Add public support, architecture, incident-response, release-process, and contribution templates.

## 0.1.0 - 2026-08-26

- Initial create-only MCP server with bounded UTF-8 reads for ChatGPT and Codex.
