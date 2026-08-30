[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$root = Join-Path $tempBase ('pcfb-crash-window-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root) | Out-Null
$encoding = New-Object Text.UTF8Encoding($false)
$previousLocalAppData = $env:LOCALAPPDATA
$previousState = $env:PCFB_TEST_STATE
$previousCrash = $env:PCFB_TEST_CRASH_AT

function Write-Json([string]$Path, [object]$Value) {
  [IO.File]::WriteAllText($Path, (($Value | ConvertTo-Json -Depth 10) + [Environment]::NewLine), $encoding)
}
function New-Volume([string]$Letter, [string]$Bus = 'NVMe') {
  $t = $Letter.ToLowerInvariant()
  [ordered]@{ DeviceID=($Letter + ':'); DriveType=3; VolumeName="Volume-$t"; VolumeSerialNumber="serial-$t"; FileSystem='NTFS'; HealthStatus='Healthy'; BusType=$Bus; DiskUniqueId="disk-$t"; PartitionUniqueId="partition-$t"; VolumeUniqueId="volume-$t"; Online=$true }
}

try {
  $points = @('candidate_written','after_stop','after_candidate_start','before_applied_hash','after_applied_hash','before_lkg_promotion')
  foreach ($point in $points) {
    $case = Join-Path $root $point
    $local = Join-Path $case 'localappdata'
    $private = Join-Path $local 'PCFileBridge\private'
    [IO.Directory]::CreateDirectory($private) | Out-Null
    $env:LOCALAPPDATA = $local
    $state = Join-Path $case 'state.json'
    $env:PCFB_TEST_STATE = $state
    Write-Json $state ([ordered]@{ running = $false })
    [IO.File]::WriteAllText((Join-Path $private 'pc-local.tunnel-id'), (('tun' + 'nel_crash_test_1234') + [Environment]::NewLine), $encoding)

    $client = Join-Path $case 'client.ps1'
    [IO.File]::WriteAllText($client, @'
$state = Get-Content -Raw -LiteralPath $env:PCFB_TEST_STATE | ConvertFrom-Json
if ($args[0] -ceq 'runtimes' -and $args[1] -ceq 'status') {
  [ordered]@{ process_running=[bool]$state.running; healthy=[bool]$state.running; ready=[bool]$state.running } | ConvertTo-Json -Compress
  exit 0
}
if ($args[0] -ceq 'runtimes' -and $args[1] -ceq 'stop') {
  [IO.File]::WriteAllText($env:PCFB_TEST_STATE, '{"running":false}', [Text.Encoding]::ASCII)
  '{}'
  exit 0
}
throw 'MOCK_ARGUMENT'
'@, $encoding)
    $connect = Join-Path $case 'connect.ps1'
    [IO.File]::WriteAllText($connect, @'
param([string]$Role,[string]$TunnelId,[string]$ConfigPath,[switch]$EnableFullDrive)
[IO.File]::WriteAllText($env:PCFB_TEST_STATE, '{"running":true}', [Text.Encoding]::ASCII)
'@, $encoding)
    $initial = Join-Path $case 'initial.json'
    $candidate = Join-Path $case 'candidate.json'
    Write-Json $initial ([ordered]@{ volumes=@((New-Volume C),(New-Volume D 'SATA')) })
    Write-Json $candidate ([ordered]@{ volumes=@((New-Volume C),(New-Volume D 'SATA'),(New-Volume F 'SAS')) })
    $config = Join-Path $private 'roots.pc-local.auto.json'
    & (Join-Path $PSScriptRoot 'Start-PCFileBridgeVolumeMonitor.ps1') -Role pc-local -Once -InventoryPath $initial -ConfigPath $config -TunnelClientPath $client -ConnectScriptPath $connect -StableSnapshots 1 -SkipMcpProbe | Out-Null
    $env:PCFB_TEST_CRASH_AT = $point
    $crashed = $false
    try {
      & (Join-Path $PSScriptRoot 'Start-PCFileBridgeVolumeMonitor.ps1') -Role pc-local -Once -InventoryPath $candidate -ConfigPath $config -TunnelClientPath $client -ConnectScriptPath $connect -StableSnapshots 1 -SkipMcpProbe | Out-Null
    } catch {
      if ($_.Exception.Message -notlike 'SIMULATED_CRASH_*') { throw }
      $crashed = $true
    }
    if (-not $crashed) { throw "CRASH_POINT_NOT_REACHED_$point" }
    $env:PCFB_TEST_CRASH_AT = ''
    $recovery = & (Join-Path $PSScriptRoot 'Start-PCFileBridgeVolumeMonitor.ps1') -Role pc-local -Once -InventoryPath $candidate -ConfigPath $config -TunnelClientPath $client -ConnectScriptPath $connect -StableSnapshots 1 -SkipMcpProbe
    if (-not [bool]$recovery.runtime_ready) { throw "CRASH_RECOVERY_FAILED_$point" }
    $active = Get-Content -Raw -LiteralPath $config | ConvertFrom-Json
    if (@($active.roots.id) -notcontains 'pc-f') { throw "CANDIDATE_NOT_RECOVERED_$point" }
  }

  $env:LOCALAPPDATA = Join-Path $root 'singleton-local'
  $singletonPrivate = Join-Path $env:LOCALAPPDATA 'PCFileBridge\private'
  [IO.Directory]::CreateDirectory($singletonPrivate) | Out-Null
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    $scope = ([BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($singletonPrivate.ToLowerInvariant())))).Replace('-', '').Substring(0, 12)
  } finally {
    $algorithm.Dispose()
  }
  $mutexName = "Local\PCFileBridgeVolumeMonitor-pc-local-$scope"
  $readyFile = Join-Path $root 'singleton-ready'
  $job = Start-Job -ArgumentList $mutexName, $readyFile -ScriptBlock {
    param($Name, $Ready)
    $held = New-Object Threading.Mutex($false, $Name)
    $owns = $held.WaitOne(0)
    if (-not $owns) { throw 'SINGLETON_TEST_MUTEX_FAILED' }
    [IO.File]::WriteAllText($Ready, 'ready', [Text.Encoding]::ASCII)
    try { Start-Sleep -Seconds 20 } finally {
      $held.ReleaseMutex()
      $held.Dispose()
    }
  }
  try {
    for ($attempt = 0; $attempt -lt 50 -and -not (Test-Path -LiteralPath $readyFile); $attempt += 1) { Start-Sleep -Milliseconds 100 }
    if (-not (Test-Path -LiteralPath $readyFile)) { throw 'SINGLETON_TEST_JOB_NOT_READY' }
    $singleton = & (Join-Path $PSScriptRoot 'Start-PCFileBridgeVolumeMonitor.ps1') -Role pc-local -Once -SkipConnect -StableSnapshots 1
    if ([string]$singleton.monitor -cne 'already_running') { throw 'MONITOR_SINGLETON_FAILED' }
  } finally {
    Stop-Job -Job $job -ErrorAction SilentlyContinue
    Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
  }
  Write-Output 'CRASH_WINDOW_WINDOWS_TEST_PASS points=6 singleton=pass recovery=pass'
} finally {
  $env:LOCALAPPDATA = $previousLocalAppData
  $env:PCFB_TEST_STATE = $previousState
  $env:PCFB_TEST_CRASH_AT = $previousCrash
  if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
