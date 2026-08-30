# PC FileBridge

[![CI](https://github.com/gexiro-global/pc-filebridge/actions/workflows/ci.yml/badge.svg)](https://github.com/gexiro-global/pc-filebridge/actions/workflows/ci.yml)
[![CodeQL](https://github.com/gexiro-global/pc-filebridge/actions/workflows/codeql.yml/badge.svg)](https://github.com/gexiro-global/pc-filebridge/actions/workflows/codeql.yml)
[![Release](https://github.com/gexiro-global/pc-filebridge/actions/workflows/release.yml/badge.svg)](https://github.com/gexiro-global/pc-filebridge/actions/workflows/release.yml)

PC FileBridge is a local Model Context Protocol (MCP) server that gives ChatGPT, Codex, and other MCP clients bounded access to operator-selected folders. It can read UTF-8 text and create new files or directories, but it cannot overwrite, append, rename, move, link, or delete.

The create-only guarantee is enforced by the server. New files use operating-system exclusive create mode (`wx`), so an existing target returns `TARGET_EXISTS` and remains unchanged.

## Security properties

- Every operation uses a configured `root_id` and a relative path.
- Absolute paths, UNC paths, traversal, alternate data streams, reserved Windows names, symlinks, junctions, and reparse-point escapes are blocked.
- Each existing component is matched to the filesystem-stored directory entry by exact file identity. Windows 8.3 and other alternate spellings are rejected; case-only spelling differences remain allowed on Windows.
- Missing, zero, unstable, or ambiguous file identity fails closed. Regular files with multiple hard links are rejected.
- Sensitive folders and credential filenames are hidden and rejected, including `.ssh`, `.aws`, `.azure`, `.codex`, `.git`, `AppData`, `.env*`, private-key formats, PuTTY `.ppk`, Java keystores, and SSH `id_*` private-key names.
- Text reads are UTF-8 only, byte-bounded, and redact common credential patterns.
- Directory listings and filename searches are bounded.
- The server has no network client and does not execute shell commands.
- A complete drive root requires an exact, explicit risk opt-in.

These controls reduce risk but cannot determine whether every ordinary document is private. Configure the narrowest useful roots and treat returned file content as untrusted data. Portable Node.js cannot provide race-free Windows `openat2` semantics, so pre/post-operation identity checks reduce but do not eliminate attacks by a more-privileged process that can mutate the filesystem concurrently.

## MCP tools

| Tool | Purpose |
|---|---|
| `list_roots` | List configured roots without revealing absolute host paths |
| `list_directory` | List bounded, non-sensitive directory entries |
| `stat_path` | Read metadata for one existing path |
| `read_text_file` | Read a bounded, redacted UTF-8 prefix |
| `search_file_names` | Search names, never file contents |
| `create_directory` | Create exactly one new directory |
| `create_text_file` | Create exactly one new UTF-8 file with exclusive create |

There are no delete, overwrite, append, patch, rename, move, remove, or unlink tools.

## Requirements

- Node.js 22 or newer
- Windows for the supplied Task Scheduler helpers, or Docker on Linux for the always-on VPS deployment
- An MCP-compatible client

The core server and policy tests also run on Linux and macOS. The hardened Docker deployment pins Node.js and the official Secure MCP Tunnel runtime by immutable OCI digest.

## Install and configure

```powershell
git clone https://github.com/gexiro-global/pc-filebridge.git
Set-Location pc-filebridge
npm ci --ignore-scripts
Copy-Item .\config\roots.example.json .\config\roots.local.json
```

Edit `config\roots.local.json` and replace the example path with one or more folders you control. The local file is ignored by Git.

Build and verify:

```powershell
npm run verify
```

Run over stdio:

```powershell
$env:FILEBRIDGE_CONFIG = (Resolve-Path .\config\roots.local.json).Path
node .\mcp\server.mjs
```

The repository includes `.mcp.json` and a Codex plugin manifest. Make sure `FILEBRIDGE_CONFIG` is available to the spawned MCP process. If no configuration exists, startup fails closed with `CONFIG_UNAVAILABLE`.

## ChatGPT Secure MCP Tunnel

For ChatGPT, create a dedicated Secure MCP Tunnel and a dedicated runtime API key. Keep the key outside the repository. The helper scripts expect the tunnel client at `%LOCALAPPDATA%\PCFileBridge\bin\tunnel-client.exe` and store the key in `%LOCALAPPDATA%\PCFileBridge\private\.env.local` with a restricted ACL.

```powershell
.\scripts\Initialize-PCFileBridgeRuntimeKey.ps1
.\scripts\Connect-PCFileBridgeTunnel.ps1 -TunnelId 'tunnel_...'
.\scripts\Get-PCFileBridgeTunnelStatus.ps1
```

The tunnel runtime must run on the computer that owns the configured folders. A VPS deployment can remain available while personal devices are offline, but it exposes files stored in its persistent server volume; it does not make a powered-off PC disk remotely readable. See [VPS deployment](docs/VPS_DEPLOYMENT.md).

Version 0.2.2 separates the main PC, laptop, and infrastructure into three role-bound tunnels. Their tunnel identifiers, runtime aliases, and root ids must never be reused across roles. The Windows and Docker launchers verify the operator-visible tunnel name before starting, and local ChatGPT connectors require an explicit `armed` operator gate. This prevents a PC and VPS poller from silently serving different backends through one connector.

ChatGPT cannot securely infer which physical device opened a conversation. Operators must select the clearly named PC, laptop, or infrastructure connector. Local Codex can instead use its device-local stdio configuration.

Windows local roles automatically discover healthy, online NTFS volumes on internal NVMe, SATA, SAS, RAID, Storage Spaces, or SCM buses. Each volume gets a stable opaque id derived from host, disk, partition, volume, and serial identity. A drive-letter change keeps the same volume id while changing the role-bound root id, for example `pc-e` to `pc-f`. Labels and raw hardware identifiers are never exposed.

File Backed Virtual, USB, SD, MMC, 1394, and removable volumes are blocked until the operator approves the exact opaque volume id in the ACL-protected private registry. Network, optical, unknown, ReFS, unhealthy, offline, incomplete-identity, and identity-collision candidates always fail closed.

```powershell
.\scripts\Get-PCFileBridgeVolumeCandidates.ps1 -Role pc-local
.\scripts\Approve-PCFileBridgeVolume.ps1 -Role pc-local -VolumeId 'vol-0123456789abcdef' -BusType 'File Backed Virtual' -Reason 'Authorized lab VHDX'
.\scripts\Revoke-PCFileBridgeVolumeApproval.ps1 -Role pc-local -VolumeId 'vol-0123456789abcdef'
```

The monitor requires three identical topology snapshots, writes a separate candidate, runs a real local seven-tool MCP probe, and only then promotes the candidate and last-known-good state. Failed and crash-interrupted candidates roll back or recover transactionally and are suppressed until topology changes. The connector is not reinstalled: callers discover the live set through `list_roots`.

See [tunnel roles and device isolation](docs/TUNNEL_ROLES.md) for the exact role contract, gate workflow, split-brain recovery, and availability limits.

For an always-on private deployment, use `deploy/docker/compose.example.yml`. It runs on digest-pinned Node.js 24 LTS as a non-root user with a read-only root filesystem, no published ports or Linux capabilities, bounded resources, external data and secret volumes, warning-only tunnel logs with rotation, and a tunnel-aware healthcheck. The runtime key and tunnel ID are mounted from files and never embedded in the image or Compose configuration.

The helper defaults to the configured narrow roots. Full-drive mode is never enabled by default.

## Optional autostart

After a successful manual connection:

```powershell
.\scripts\Install-PCFileBridgeAutostart.ps1 -TunnelId 'tunnel_...'
```

The installer creates a new per-user scheduled task and refuses to replace an existing task.

For role-bound automatic volume discovery, install the dedicated per-user task:

```powershell
.\scripts\Install-PCFileBridgeRoleAutostart.ps1 -Role pc-local
```

If the protected tunnel runtime intentionally uses a separate local application-data directory, pass its absolute path with `-RuntimeLocalAppData`. The task script runs a singleton monitor and does not contain a tunnel identifier or API key in its arguments. Both installers create long-running tasks with no finite execution limit and do not stop them on battery or idle transitions; they refuse to replace an existing task.

## Full-drive mode

Exposing an entire drive materially increases disclosure risk. The server refuses a filesystem root unless both the full-drive configuration and this exact process variable are supplied:

```powershell
$env:FILEBRIDGE_CONFIG = (Resolve-Path .\config\roots.full-drive.example.json).Path
$env:FILEBRIDGE_ALLOW_DRIVE_ROOT = 'I_ACCEPT_FULL_DRIVE_ACCESS_RISK'
node .\mcp\server.mjs
```

The Windows tunnel helper performs the same opt-in only when explicitly called with `-EnableFullDrive $true`.

## Development

```powershell
npm ci --ignore-scripts
npm run check
npm pack --dry-run --ignore-scripts
```

`npm run check` performs a tracked-file secret scan, type checking, policy tests, a production build, license and package-content checks, and a real MCP stdio smoke test that requires exactly seven tools and zero forbidden mutation tools. Pull requests run on Ubuntu and Windows with Node.js 22 and 24. Windows jobs must create and reject a real 8.3 alternate-name fixture and cannot silently skip that check.

## Release verification

Official releases contain four downloadable files:

- `pc-filebridge-vX.Y.Z-runtime-npm.tgz`
- `pc-filebridge-vX.Y.Z-source.tar.gz`
- `pc-filebridge-vX.Y.Z-sbom.cdx.json`
- `SHA256SUMS`

Download all files into one empty directory and verify the hashes before installation. On Windows:

```powershell
Get-Content .\SHA256SUMS | ForEach-Object {
  $hash, $name = $_ -split '  ', 2
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $name).Hash.ToLowerInvariant() -ne $hash) {
    throw "Checksum mismatch: $name"
  }
}
```

The GitHub release also carries build-provenance attestations. See [Release verification](docs/RELEASE_VERIFICATION.md), [container image security](docs/IMAGE_SECURITY.md), and [Release process](docs/RELEASE_PROCESS.md).

## Privacy and security

PC FileBridge is self-hosted and includes no telemetry. Data requested through MCP is sent to the connected client and is then subject to that client's provider and workspace policies. Read [ARCHITECTURE.md](ARCHITECTURE.md), [PRIVACY.md](PRIVACY.md), [SECURITY.md](SECURITY.md), [SUPPORT.md](SUPPORT.md), and [THREAT_MODEL.md](THREAT_MODEL.md) before exposing sensitive folders.

## License

Apache-2.0. Copyright 2026 Gexiro Global Enterprises Ltd.
