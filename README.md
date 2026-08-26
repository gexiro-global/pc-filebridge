# PC FileBridge

PC FileBridge is a local Model Context Protocol (MCP) server that gives ChatGPT, Codex, and other MCP clients bounded access to operator-selected folders. It can read UTF-8 text and create new files or directories, but it cannot overwrite, append, rename, move, link, or delete.

The create-only guarantee is enforced by the server. New files use operating-system exclusive create mode (`wx`), so an existing target returns `TARGET_EXISTS` and remains unchanged.

## Security properties

- Every operation uses a configured `root_id` and a relative path.
- Absolute paths, UNC paths, traversal, alternate data streams, reserved Windows names, symlinks, junctions, and reparse-point escapes are blocked.
- Sensitive folders and credential filenames are hidden and rejected, including `.ssh`, `.aws`, `.azure`, `.codex`, `.git`, `AppData`, `.env*`, private-key formats, PuTTY `.ppk`, Java keystores, and SSH `id_*` private-key names.
- Text reads are UTF-8 only, byte-bounded, and redact common credential patterns.
- Directory listings and filename searches are bounded.
- The server has no network client and does not execute shell commands.
- A complete drive root requires an exact, explicit risk opt-in.

These controls reduce risk but cannot determine whether every ordinary document is private. Configure the narrowest useful roots and treat returned file content as untrusted data.

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
- Windows for the supplied Secure MCP Tunnel and Task Scheduler helpers
- An MCP-compatible client

The core server and policy tests also run on Linux and macOS.

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

The tunnel runtime must run on the computer that owns the configured folders. A remote VPS does not gain access to a PC disk unless a separately secured private channel reaches a runtime on that PC.

The helper defaults to the configured narrow roots. Full-drive mode is never enabled by default.

## Optional autostart

After a successful manual connection:

```powershell
.\scripts\Install-PCFileBridgeAutostart.ps1 -TunnelId 'tunnel_...'
```

The installer creates a new per-user scheduled task and refuses to replace an existing task.

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

`npm run check` performs a tracked-file secret scan, type checking, 21 policy tests, a production build, and a real MCP stdio smoke test that requires exactly seven tools and zero forbidden mutation tools.

## Privacy and security

PC FileBridge is self-hosted and includes no telemetry. Data requested through MCP is sent to the connected client and is then subject to that client's provider and workspace policies. Read [PRIVACY.md](PRIVACY.md), [SECURITY.md](SECURITY.md), and [THREAT_MODEL.md](THREAT_MODEL.md) before exposing sensitive folders.

## License

Apache-2.0. Copyright 2026 Gexiro Global Enterprises Ltd.
