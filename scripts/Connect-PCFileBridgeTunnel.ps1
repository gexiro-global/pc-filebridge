[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^tunnel_[A-Za-z0-9_-]{8,}$')]
  [string]$TunnelId,
  [string]$TunnelClientPath = (Join-Path $env:LOCALAPPDATA 'PCFileBridge\bin\tunnel-client.exe'),
  [string]$EnvironmentFile = (Join-Path $env:LOCALAPPDATA 'PCFileBridge\private\.env.local'),
  [string]$ConfigPath = (Join-Path $PSScriptRoot '..\config\roots.local.json'),
  [string]$Alias = 'pc-filebridge',
  [string]$ProfileDirectory = (Join-Path $env:LOCALAPPDATA 'PCFileBridge\tunnel-client'),
  [bool]$EnableFullDrive = $false
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$tunnelClient = (Resolve-Path -LiteralPath $TunnelClientPath -ErrorAction Stop).Path
$environmentPath = (Resolve-Path -LiteralPath $EnvironmentFile -ErrorAction Stop).Path
$pluginRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..') -ErrorAction Stop).Path
Resolve-Path -LiteralPath (Join-Path $pluginRoot 'mcp\server.mjs') -ErrorAction Stop | Out-Null
$selectedConfig = if ($EnableFullDrive) {
  (Resolve-Path -LiteralPath (Join-Path $pluginRoot 'config\roots.full-drive.example.json') -ErrorAction Stop).Path
} else {
  (Resolve-Path -LiteralPath $ConfigPath -ErrorAction Stop).Path
}
$node = (Get-Command node -ErrorAction Stop).Source
[IO.Directory]::CreateDirectory([IO.Path]::GetFullPath($ProfileDirectory)) | Out-Null

$keyEntries = @([IO.File]::ReadAllLines($environmentPath) | Where-Object { $_ -match '^OPENAI_API_KEY=\S+$' })
if ($keyEntries.Count -ne 1) { throw 'Expected exactly one OPENAI_API_KEY entry in the private environment file.' }
$keyValue = $keyEntries[0].Substring($keyEntries[0].IndexOf('=') + 1)
# tunnel-client parses --mcp-command with POSIX-style quoting even on Windows.
# Resolve Node during preflight, then invoke it by basename through the system PATH
# and keep the server path relative to the plugin working directory. This avoids
# the current Windows parser treating backslashes in an absolute path as escapes.
$nodeCommand = [IO.Path]::GetFileName($node)
$mcpCommand = '{0} mcp/server.mjs' -f $nodeCommand
$previousLocation = (Get-Location).Path
$previousConfig = [Environment]::GetEnvironmentVariable('FILEBRIDGE_CONFIG', 'Process')
$previousDriveOptIn = [Environment]::GetEnvironmentVariable('FILEBRIDGE_ALLOW_DRIVE_ROOT', 'Process')
try {
  Set-Location -LiteralPath $pluginRoot
  [Environment]::SetEnvironmentVariable('FILEBRIDGE_CONFIG', $selectedConfig, 'Process')
  if ($EnableFullDrive) {
    [Environment]::SetEnvironmentVariable('FILEBRIDGE_ALLOW_DRIVE_ROOT', 'I_ACCEPT_FULL_DRIVE_ACCESS_RISK', 'Process')
  } else {
    [Environment]::SetEnvironmentVariable('FILEBRIDGE_ALLOW_DRIVE_ROOT', $null, 'Process')
  }
  [Environment]::SetEnvironmentVariable('OPENAI_API_KEY', $keyValue, 'Process')
  $connectRaw = @(& $tunnelClient runtimes connect `
    --alias $Alias `
    --profile $Alias `
    --profile-dir $ProfileDirectory `
    --tunnel-id $TunnelId `
    --runtime-api-key 'env:OPENAI_API_KEY' `
    --mcp-command $mcpCommand `
    --json)
  $connectExit = $LASTEXITCODE
  if ($connectExit -ne 0) { throw 'tunnel-client failed to connect the managed runtime.' }
  $connect = ($connectRaw -join [Environment]::NewLine) | ConvertFrom-Json
} finally {
  [Environment]::SetEnvironmentVariable('OPENAI_API_KEY', $null, 'Process')
  [Environment]::SetEnvironmentVariable('FILEBRIDGE_CONFIG', $previousConfig, 'Process')
  [Environment]::SetEnvironmentVariable('FILEBRIDGE_ALLOW_DRIVE_ROOT', $previousDriveOptIn, 'Process')
  $keyValue = $null
  $selectedConfig = $null
  Set-Location -LiteralPath $previousLocation
}

$statusRaw = @(& $tunnelClient runtimes status $Alias --json)
$statusExit = $LASTEXITCODE
if ($statusExit -ne 0) { throw 'tunnel-client could not verify the managed runtime status.' }
$status = ($statusRaw -join [Environment]::NewLine) | ConvertFrom-Json
$issueCount = @($status.local.issues | Where-Object { $null -ne $_ }).Count
if (-not $status.process_running -or -not $status.healthy -or -not $status.ready) {
  throw 'PC FileBridge runtime did not reach running, healthy, and ready state.'
}
[pscustomobject]@{
  alias = [string]$status.alias
  tunnel_id = [string]$status.tunnel_id
  already_running = [bool]$connect.already_running
  process_running = [bool]$status.process_running
  healthy = [bool]$status.healthy
  ready = [bool]$status.ready
  runtime_state = [string]$status.runtime_state
  issue_count = $issueCount
} | ConvertTo-Json
