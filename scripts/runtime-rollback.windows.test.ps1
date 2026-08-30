[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$tempRoot = Join-Path $tempBase ('pc-filebridge-rollback-test-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($tempRoot) | Out-Null
if (-not ([IO.Path]::GetFullPath($tempRoot)).StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) { throw 'TEMP_SCOPE_INVALID' }
$encoding = New-Object Text.UTF8Encoding($false)
$previousLocalAppData = $env:LOCALAPPDATA
$previousState = $env:PCFB_TEST_STATE
$previousFailure = $env:PCFB_TEST_FAIL_CANDIDATE

function Write-Json([string]$Path, [object]$Value) {
  [IO.File]::WriteAllText($Path, (($Value | ConvertTo-Json -Depth 10) + [Environment]::NewLine), $encoding)
}

function New-VolumeFixture([string]$DeviceID, [string]$BusType = 'NVMe') {
  $token = $DeviceID.Substring(0, 1).ToLowerInvariant()
  [ordered]@{
    DeviceID = $DeviceID
    DriveType = 3
    VolumeName = "Volume-$token"
    VolumeSerialNumber = "serial-$token"
    FileSystem = 'NTFS'
    HealthStatus = 'Healthy'
    BusType = $BusType
    DiskUniqueId = "disk-$token"
    PartitionUniqueId = "partition-$token"
    VolumeUniqueId = "volume-$token"
  }
}

try {
  $localAppData = Join-Path $tempRoot 'localappdata'
  $privateRoot = Join-Path $localAppData 'PCFileBridge\private'
  [IO.Directory]::CreateDirectory($privateRoot) | Out-Null
  $env:LOCALAPPDATA = $localAppData
  $statePath = Join-Path $tempRoot 'runtime-state.json'
  $env:PCFB_TEST_STATE = $statePath
  $env:PCFB_TEST_FAIL_CANDIDATE = '0'
  Write-Json -Path $statePath -Value ([ordered]@{ running = $false })
  $testTunnelId = 'tunnel_' + 'test_runtime_1234'
  [IO.File]::WriteAllText((Join-Path $privateRoot 'pc-local.tunnel-id'), ($testTunnelId + [Environment]::NewLine), $encoding)
  [IO.File]::WriteAllText((Join-Path $privateRoot 'pc-local.gate'), ("ARMED:pc-local" + [Environment]::NewLine), $encoding)

  $tunnelClient = Join-Path $tempRoot 'mock-tunnel-client.ps1'
  [IO.File]::WriteAllText($tunnelClient, @'
$ErrorActionPreference = 'Stop'
$state = Get-Content -Raw -LiteralPath $env:PCFB_TEST_STATE | ConvertFrom-Json
if ($args.Count -ge 2 -and $args[0] -ceq 'runtimes' -and $args[1] -ceq 'status') {
  [ordered]@{ process_running = [bool]$state.running; healthy = [bool]$state.running; ready = [bool]$state.running } | ConvertTo-Json -Compress
  exit 0
}
if ($args.Count -ge 2 -and $args[0] -ceq 'runtimes' -and $args[1] -ceq 'stop') {
  [IO.File]::WriteAllText($env:PCFB_TEST_STATE, '{"running":false}', [Text.Encoding]::ASCII)
  '{}'
  exit 0
}
throw 'MOCK_TUNNEL_CLIENT_ARGUMENT'
'@, $encoding)

  $connectScript = Join-Path $tempRoot 'mock-connect.ps1'
  [IO.File]::WriteAllText($connectScript, @'
param(
  [string]$Role,
  [string]$TunnelId,
  [string]$ConfigPath,
  [switch]$EnableFullDrive
)
$config = Get-Content -Raw -LiteralPath $ConfigPath | ConvertFrom-Json
if ($env:PCFB_TEST_FAIL_CANDIDATE -ceq '1' -and @($config.roots.id) -contains 'pc-f') {
  throw 'MOCK_CANDIDATE_CONNECT_FAILED'
}
[IO.File]::WriteAllText($env:PCFB_TEST_STATE, '{"running":true}', [Text.Encoding]::ASCII)
'@, $encoding)

  $initialInventory = Join-Path $tempRoot 'initial.json'
  Write-Json -Path $initialInventory -Value ([ordered]@{ volumes = @(
    (New-VolumeFixture -DeviceID 'C:' -BusType 'NVMe'),
    (New-VolumeFixture -DeviceID 'D:' -BusType 'SATA')
  ) })
  $configPath = Join-Path $privateRoot 'roots.pc-local.auto.json'
  $first = & (Join-Path $PSScriptRoot 'Start-PCFileBridgeVolumeMonitor.ps1') -Role pc-local -Once -InventoryPath $initialInventory -ConfigPath $configPath -TunnelClientPath $tunnelClient -ConnectScriptPath $connectScript -StableSnapshots 1 -SkipMcpProbe
  if (-not [bool]$first.runtime_ready -or [bool]$first.rollback_applied) { throw 'INITIAL_CONNECT_FAILED' }
  if (-not (Test-Path -LiteralPath (Join-Path $privateRoot 'roots.pc-local.last-good.json'))) { throw 'LKG_NOT_CREATED' }

  $candidateInventory = Join-Path $tempRoot 'candidate.json'
  Write-Json -Path $candidateInventory -Value ([ordered]@{ volumes = @(
    (New-VolumeFixture -DeviceID 'C:' -BusType 'NVMe'),
    (New-VolumeFixture -DeviceID 'D:' -BusType 'SATA'),
    (New-VolumeFixture -DeviceID 'F:' -BusType 'SAS')
  ) })
  $env:PCFB_TEST_FAIL_CANDIDATE = '1'
  $second = & (Join-Path $PSScriptRoot 'Start-PCFileBridgeVolumeMonitor.ps1') -Role pc-local -Once -InventoryPath $candidateInventory -ConfigPath $configPath -TunnelClientPath $tunnelClient -ConnectScriptPath $connectScript -StableSnapshots 1 -SkipMcpProbe
  if (-not [bool]$second.runtime_ready -or -not [bool]$second.rollback_applied -or [string]$second.runtime_action -cne 'candidate_failed_rolled_back') {
    throw 'ROLLBACK_NOT_APPLIED'
  }
  $activeAfterRollback = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
  if (@($activeAfterRollback.roots.id) -contains 'pc-f') { throw 'FAILED_CANDIDATE_REMAINED_ACTIVE' }

  $third = & (Join-Path $PSScriptRoot 'Start-PCFileBridgeVolumeMonitor.ps1') -Role pc-local -Once -InventoryPath $candidateInventory -ConfigPath $configPath -TunnelClientPath $tunnelClient -ConnectScriptPath $connectScript -StableSnapshots 1 -SkipMcpProbe
  if ([string]$third.runtime_action -cne 'rejected_skipped_lkg_active' -or -not [bool]$third.runtime_ready) {
    throw 'REJECTED_TOPOLOGY_RETRY_NOT_SUPPRESSED'
  }
  Write-Output 'RUNTIME_ROLLBACK_WINDOWS_TEST_PASS candidate=failed rollback=ready rejected=skipped'
} finally {
  $env:LOCALAPPDATA = $previousLocalAppData
  $env:PCFB_TEST_STATE = $previousState
  $env:PCFB_TEST_FAIL_CANDIDATE = $previousFailure
  if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
}
