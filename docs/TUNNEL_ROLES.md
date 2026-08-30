# Tunnel roles and device isolation

PC FileBridge 0.2.2 uses three distinct Secure MCP Tunnel identities. A tunnel identifier must never be shared by two roles or by two active pollers.

| Role | Required tunnel name | Runtime alias | Root ids |
|---|---|---|---|
| `pc-local` | `PC FileBridge - PC Local` | `pc-filebridge-pc-local` | detected fixed volumes as `pc-a` through `pc-z` |
| `laptop-local` | `PC FileBridge - Laptop Local` | `pc-filebridge-laptop-local` | detected fixed volumes as `laptop-a` through `laptop-z` |
| `infrastructure` | `PC FileBridge - Infrastructure` | `pc-filebridge-infrastructure` | `primary-data`, `secondary-data`, optional `agent-data` |

The role contract is machine-readable in `config/tunnel-roles.json`. Windows and container launchers verify the control-plane tunnel name before starting. A tunnel created for one role therefore fails closed when its identifier is accidentally installed in another role.

## Automatic fixed-volume discovery on Windows

`Start-PCFileBridgeVolumeMonitor.ps1` inventories Windows logical disks with `DriveType=3` every 15 seconds, then joins each letter to its disk, partition, volume, and serial identity. Healthy online NTFS volumes on NVMe, SATA, SAS, RAID, Storage Spaces, or SCM are auto-exposed. New accepted drive-letter partitions are added in deterministic letter order and removed volumes are withdrawn.

The stable opaque `volume_id` is derived from a versioned schema plus host id, disk identity, partition identity, volume identity, and serial. Its input intentionally excludes drive letter, label, bus, filesystem, health, and online state. Reassigning `E:\` to `F:\` therefore retains the volume id while changing `pc-e` to `pc-f`. Missing, zero, duplicate, or colliding identities fail closed.

File Backed Virtual, USB, SD, MMC, 1394, and removable volumes require an explicit approval for the exact opaque volume id and observed bus type. The approval registry lives outside the repository under `%LOCALAPPDATA%\PCFileBridge\private`, disables inheritance, and grants access only to the current user and SYSTEM. Network, optical, unknown, ReFS, unhealthy, offline, and incomplete candidates remain blocked regardless of approval.

The monitor requires three consecutive matching snapshots. It writes a separate candidate, validates role/path policy, starts only the matching runtime, performs a real local MCP probe for exactly seven tools and the expected roots, records the applied hash, and only then promotes last-known-good state. Six injected crash windows recover transactionally; a role-scoped named mutex prevents a second monitor. Rejected topologies are suppressed until their topology hash changes.

Operator approval workflow:

```powershell
.\scripts\Get-PCFileBridgeVolumeCandidates.ps1 -Role pc-local
.\scripts\Approve-PCFileBridgeVolume.ps1 -Role pc-local -VolumeId "vol-0123456789abcdef" -BusType "File Backed Virtual" -Reason "Authorized lab VHDX"
.\scripts\Revoke-PCFileBridgeVolumeApproval.ps1 -Role pc-local -VolumeId "vol-0123456789abcdef"
```

Run the Windows-only fail-closed tests with:

```powershell
npm run test:volume-discovery:windows
npm run test:runtime-rollback:windows
npm run test:crash-window:windows
```

## Local Codex

Local Codex may launch the stdio MCP server directly with the device-specific configuration. No Secure MCP Tunnel is required for that local path.

Copy exactly one example to the ignored `config/roots.local.json`:

- main PC: `config/roots.pc.example.json`;
- laptop: `config/roots.laptop.example.json`.

Remove the laptop D root when the device has no D drive. Complete drive roots still require the exact full-drive process opt-in.

## ChatGPT and GPT Classic

ChatGPT is cloud-hosted and cannot cryptographically infer whether a conversation was opened on the PC or laptop. Device separation therefore uses distinct connectors and tunnels, not prompts, User-Agent strings, IP addresses, or conversation names.

Local roles require an operator gate. The gate is locked by default because absence, an invalid value, or the wrong role all fail closed.

Arm only the device currently in use:

```powershell
.\scripts\Set-PCFileBridgeGate.ps1 -Role pc-local -State Armed
```

Lock it after use:

```powershell
.\scripts\Set-PCFileBridgeGate.ps1 -Role pc-local -State Locked
```

The laptop uses `laptop-local` in the same commands.

Start a role-bound runtime only with its own tunnel and configuration:

```powershell
.\scripts\Connect-PCFileBridgeRoleTunnel.ps1 `
  -Role pc-local `
  -TunnelId 'tunnel_...' `
  -ConfigPath .\config\roots.local.json `
  -EnableFullDrive
```

The launcher verifies all of the following before it starts:

1. the local operator gate is armed for the exact role;
2. configured root ids exactly match the role contract;
3. full-drive access has an explicit process opt-in;
4. the OpenAI control-plane tunnel name exactly matches the role;
5. the runtime reaches running, healthy, and ready state.

For automatic fixed-volume discovery and runtime recovery, launch the monitor instead of the one-shot connector:

```powershell
.\scripts\Start-PCFileBridgeVolumeMonitor.ps1 -Role pc-local
```

The supplied `Connect-PCFileBridgeRoleTunnel-Task.ps1` invokes this monitor and is suitable for a hidden per-user Startup shortcut. Only one monitor instance per role runs at a time.

## Infrastructure hub

Only the infrastructure host runs the `infrastructure` tunnel-client poller. Secondary hosts and remote agents must not run additional pollers with that tunnel identifier.

The infrastructure FileBridge process can expose only paths mounted on its own host. Secondary hosts and remote agents data require separately authorized host mounts or agents. Their absence must make the corresponding root unavailable; it must not silently fall back to another host.

## Availability truth

A powered-off PC cannot expose `pc-c` or `pc-d`. A powered-off laptop cannot expose `laptop-c` or `laptop-d`. PC FileBridge does not mirror complete local drives to the VPS.

The infrastructure connector may remain available while personal devices are offline because its roots live on infrastructure storage.

## Incident recovery

If one connector alternates between unrelated root sets, treat it as split-brain:

1. compare tunnel identifiers only by a secure hash;
2. identify every active tunnel-client poller;
3. stop the unintended poller without deleting its data or secrets;
4. keep only one poller per tunnel identifier;
5. create a new, role-specific tunnel before re-enabling the stopped role;
6. verify repeated `list_roots` calls and one bounded directory listing.
