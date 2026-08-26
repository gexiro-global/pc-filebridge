[CmdletBinding()]
param(
  [string]$TunnelClientPath = (Join-Path $env:LOCALAPPDATA 'PCFileBridge\bin\tunnel-client.exe'),
  [string]$Alias = 'pc-filebridge'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$tunnelClient = (Resolve-Path -LiteralPath $TunnelClientPath -ErrorAction Stop).Path
$statusRaw = @(& $tunnelClient runtimes status $Alias --json)
$statusExit = $LASTEXITCODE
if ($statusExit -ne 0) { throw 'tunnel-client status check failed.' }
$status = ($statusRaw -join [Environment]::NewLine) | ConvertFrom-Json
[pscustomobject]@{
  alias = [string]$status.alias
  tunnel_id = [string]$status.tunnel_id
  process_running = [bool]$status.process_running
  healthy = [bool]$status.healthy
  ready = [bool]$status.ready
  runtime_state = [string]$status.runtime_state
  issue_count = @($status.local.issues | Where-Object { $null -ne $_ }).Count
} | ConvertTo-Json
