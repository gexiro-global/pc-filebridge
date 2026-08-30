[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('pc-local', 'laptop-local')]
  [string]$Role,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^tunnel_[A-Za-z0-9_-]{8,}$')]
  [string]$TunnelId,
  [Parameter(Mandatory = $true)]
  [string]$ConfigPath,
  [string]$TunnelClientPath = (Join-Path $env:LOCALAPPDATA 'PCFileBridge\bin\tunnel-client.exe'),
  [string]$EnvironmentFile = (Join-Path $env:LOCALAPPDATA 'PCFileBridge\private\.env.local'),
  [string]$NodePath = '',
  [string]$GateFile = '',
  [string]$ProfileDirectory = '',
  [switch]$EnableFullDrive
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$pluginRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..') -ErrorAction Stop).Path
$selectedConfig = (Resolve-Path -LiteralPath $ConfigPath -ErrorAction Stop).Path
$validationScript = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'Test-PCFileBridgeRoleConfig.ps1') -ErrorAction Stop).Path
$roleValidation = & $validationScript -Role $Role -ConfigPath $selectedConfig
$alias = [string]$roleValidation.alias
$expectedTunnelName = [string]$roleValidation.expectedTunnelName

if ([bool]$roleValidation.gateRequired) {
  if ([string]::IsNullOrWhiteSpace($GateFile)) {
    $GateFile = Join-Path $env:LOCALAPPDATA "PCFileBridge\private\$Role.gate"
  }
  $gatePath = (Resolve-Path -LiteralPath $GateFile -ErrorAction Stop).Path
  $gateState = [IO.File]::ReadAllText($gatePath, [Text.Encoding]::UTF8).Trim()
  if ($gateState -cne "ARMED:$Role") { throw 'LOCAL_CONNECTOR_LOCKED' }
}

$tunnelClient = (Resolve-Path -LiteralPath $TunnelClientPath -ErrorAction Stop).Path
$environmentPath = (Resolve-Path -LiteralPath $EnvironmentFile -ErrorAction Stop).Path
Resolve-Path -LiteralPath (Join-Path $pluginRoot 'mcp\server.mjs') -ErrorAction Stop | Out-Null

if ([bool]$roleValidation.usesDriveRoot -and -not $EnableFullDrive) {
  throw 'DRIVE_ROOT_OPT_IN_REQUIRED'
}

$node = if ([string]::IsNullOrWhiteSpace($NodePath)) {
  (Get-Command node -ErrorAction Stop).Source
} else {
  (Resolve-Path -LiteralPath $NodePath -ErrorAction Stop).Path
}
if ([string]::IsNullOrWhiteSpace($ProfileDirectory)) {
  $ProfileDirectory = Join-Path $env:LOCALAPPDATA "PCFileBridge\tunnel-client\$Role"
}
[IO.Directory]::CreateDirectory([IO.Path]::GetFullPath($ProfileDirectory)) | Out-Null

$keyEntries = @([IO.File]::ReadAllLines($environmentPath) | Where-Object { $_ -match '^OPENAI_API_KEY=\S+$' })
if ($keyEntries.Count -ne 1) { throw 'RUNTIME_KEY_INVALID' }
$keyValue = $keyEntries[0].Substring($keyEntries[0].IndexOf('=') + 1)

$previousLocation = (Get-Location).Path
$previousConfig = [Environment]::GetEnvironmentVariable('FILEBRIDGE_CONFIG', 'Process')
$previousDriveOptIn = [Environment]::GetEnvironmentVariable('FILEBRIDGE_ALLOW_DRIVE_ROOT', 'Process')
$previousRuntimeKey = [Environment]::GetEnvironmentVariable('OPENAI_API_KEY', 'Process')
$previousControlPlaneKey = [Environment]::GetEnvironmentVariable('CONTROL_PLANE_API_KEY', 'Process')
try {
  [Environment]::SetEnvironmentVariable('CONTROL_PLANE_API_KEY', $keyValue, 'Process')
  $metadata = $null
  for ($attempt = 1; $attempt -le 3; $attempt += 1) {
    $metadataRaw = @(& $tunnelClient admin --json tunnels get $TunnelId)
    if ($LASTEXITCODE -eq 0) {
      $metadata = ($metadataRaw -join [Environment]::NewLine) | ConvertFrom-Json
      break
    }
    if ($attempt -lt 3) { Start-Sleep -Seconds 2 }
  }
  if ($null -eq $metadata) { throw 'TUNNEL_METADATA_UNAVAILABLE' }
  if ([string]$metadata.name -cne $expectedTunnelName) { throw 'TUNNEL_ROLE_MISMATCH' }

  Set-Location -LiteralPath $pluginRoot
  [Environment]::SetEnvironmentVariable('FILEBRIDGE_CONFIG', $selectedConfig, 'Process')
  [Environment]::SetEnvironmentVariable(
    'FILEBRIDGE_ALLOW_DRIVE_ROOT',
    $(if ($EnableFullDrive) { 'I_ACCEPT_FULL_DRIVE_ACCESS_RISK' } else { $null }),
    'Process'
  )
  [Environment]::SetEnvironmentVariable('OPENAI_API_KEY', $keyValue, 'Process')
  $nodeCommand = [IO.Path]::GetFileName($node)
  $mcpCommand = '{0} mcp/server.mjs' -f $nodeCommand
  $connectRaw = @(& $tunnelClient runtimes connect `
    --alias $alias `
    --profile $alias `
    --profile-dir $ProfileDirectory `
    --tunnel-id $TunnelId `
    --runtime-api-key 'env:OPENAI_API_KEY' `
    --mcp-command $mcpCommand `
    --json)
  if ($LASTEXITCODE -ne 0) { throw 'TUNNEL_CONNECT_FAILED' }
  $connect = ($connectRaw -join [Environment]::NewLine) | ConvertFrom-Json
} finally {
  [Environment]::SetEnvironmentVariable('OPENAI_API_KEY', $previousRuntimeKey, 'Process')
  [Environment]::SetEnvironmentVariable('CONTROL_PLANE_API_KEY', $previousControlPlaneKey, 'Process')
  [Environment]::SetEnvironmentVariable('FILEBRIDGE_CONFIG', $previousConfig, 'Process')
  [Environment]::SetEnvironmentVariable('FILEBRIDGE_ALLOW_DRIVE_ROOT', $previousDriveOptIn, 'Process')
  $keyValue = $null
  Set-Location -LiteralPath $previousLocation
}

$statusRaw = @(& $tunnelClient runtimes status $alias --json)
if ($LASTEXITCODE -ne 0) { throw 'TUNNEL_STATUS_FAILED' }
$status = ($statusRaw -join [Environment]::NewLine) | ConvertFrom-Json
$issueCount = @($status.local.issues | Where-Object { $null -ne $_ }).Count
if (-not $status.process_running -or -not $status.healthy -or -not $status.ready) {
  throw 'TUNNEL_RUNTIME_NOT_READY'
}
[pscustomobject]@{
  role = $Role
  alias = $alias
  already_running = [bool]$connect.already_running
  process_running = [bool]$status.process_running
  healthy = [bool]$status.healthy
  ready = [bool]$status.ready
  runtime_state = [string]$status.runtime_state
  issue_count = $issueCount
} | ConvertTo-Json
