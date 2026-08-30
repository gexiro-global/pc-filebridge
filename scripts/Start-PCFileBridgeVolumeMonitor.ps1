[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('pc-local', 'laptop-local')]
  [string]$Role,
  [ValidateRange(5, 3600)]
  [int]$PollSeconds = 15,
  [ValidateRange(1, 10)]
  [int]$StableSnapshots = 3,
  [string]$InventoryPath = '',
  [string]$ConfigPath = '',
  [string]$TunnelIdPath = '',
  [string]$TunnelClientPath = (Join-Path $env:LOCALAPPDATA 'PCFileBridge\bin\tunnel-client.exe'),
  [string]$ConnectScriptPath = '',
  [switch]$Once,
  [switch]$SkipConnect,
  [switch]$SkipMcpProbe
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$pluginRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..') -ErrorAction Stop).Path
if ([string]::IsNullOrWhiteSpace($ConnectScriptPath)) { $ConnectScriptPath = Join-Path $PSScriptRoot 'Connect-PCFileBridgeRoleTunnel.ps1' }
$resolvedConnectScript = (Resolve-Path -LiteralPath $ConnectScriptPath -ErrorAction Stop).Path
$contract = Get-Content -Raw -LiteralPath (Join-Path $pluginRoot 'config\tunnel-roles.json') | ConvertFrom-Json
$roleContract = @($contract.roles | Where-Object { $_.id -ceq $Role })
if ($roleContract.Count -ne 1) { throw 'ROLE_CONTRACT_INVALID' }
$alias = [string]$roleContract[0].alias

$privateRoot = Join-Path $env:LOCALAPPDATA 'PCFileBridge\private'
[IO.Directory]::CreateDirectory($privateRoot) | Out-Null
if ([string]::IsNullOrWhiteSpace($ConfigPath)) { $ConfigPath = Join-Path $privateRoot "roots.$Role.auto.json" }
if ([string]::IsNullOrWhiteSpace($TunnelIdPath)) { $TunnelIdPath = Join-Path $privateRoot "$Role.tunnel-id" }
$ConfigPath = [IO.Path]::GetFullPath($ConfigPath)
$candidateConfigPath = "$ConfigPath.candidate"
$appliedHashPath = Join-Path $privateRoot "roots.$Role.applied.sha256"
$lastGoodConfigPath = Join-Path $privateRoot "roots.$Role.last-good.json"
$lastGoodHashPath = Join-Path $privateRoot "roots.$Role.last-good.sha256"
$rejectedHashPath = Join-Path $privateRoot "roots.$Role.rejected.sha256"
$stableStatePath = Join-Path $privateRoot "roots.$Role.stable-snapshots.json"
$tunnelClient = if ($SkipConnect) { $null } else { (Resolve-Path -LiteralPath $TunnelClientPath -ErrorAction Stop).Path }

function Set-PrivateStateFile([string]$Path, [string]$Value, [System.Text.Encoding]$Encoding) {
  [IO.File]::WriteAllText($Path, $Value, $Encoding)
  $current = [Security.Principal.WindowsIdentity]::GetCurrent()
  & icacls.exe $Path /inheritance:r /grant:r ('*' + $current.User.Value + ':(F)') '*S-1-5-18:(F)' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'MONITOR_STATE_ACL_FAILED' }
}

function Get-FileSha256([string]$Path) {
  $algorithm = [Security.Cryptography.SHA256]::Create()
  $stream = [IO.File]::OpenRead($Path)
  try { return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
  finally { $stream.Dispose(); $algorithm.Dispose() }
}

function Get-CombinedHash([string]$ConfigHash, [string]$TopologyHash) {
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::ASCII.GetBytes(($ConfigHash + ':' + $TopologyHash))))).Replace('-', '').ToLowerInvariant()
  } finally { $algorithm.Dispose() }
}

function Get-RuntimeStatus {
  $raw = @(& $tunnelClient runtimes status $alias --json 2>$null)
  if ($LASTEXITCODE -ne 0) { return $null }
  try { return (($raw -join [Environment]::NewLine) | ConvertFrom-Json) } catch { return $null }
}

function Invoke-LocalMcpProbe([string]$Path, [string[]]$ExpectedRoots) {
  if ($SkipMcpProbe) { return }
  $previousConfig = $env:FILEBRIDGE_CONFIG
  $previousRoots = $env:PCFB_EXPECTED_ROOTS
  $previousOptIn = $env:FILEBRIDGE_ALLOW_DRIVE_ROOT
  try {
    $env:FILEBRIDGE_CONFIG = $Path
    $env:PCFB_EXPECTED_ROOTS = ($ExpectedRoots | Sort-Object) -join ','
    $env:FILEBRIDGE_ALLOW_DRIVE_ROOT = 'I_ACCEPT_FULL_DRIVE_ACCESS_RISK'
    & (Get-Command node -ErrorAction Stop).Source (Join-Path $PSScriptRoot 'mcp-config-smoke.mjs') | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'LOCAL_MCP_SMOKE_FAILED' }
  } finally {
    $env:FILEBRIDGE_CONFIG = $previousConfig
    $env:PCFB_EXPECTED_ROOTS = $previousRoots
    $env:FILEBRIDGE_ALLOW_DRIVE_ROOT = $previousOptIn
  }
}

function Invoke-CrashPoint([string]$Name) {
  if ($env:PCFB_TEST_CRASH_AT -ceq $Name) { throw "SIMULATED_CRASH_$Name" }
}

$mutexAlgorithm = [Security.Cryptography.SHA256]::Create()
try {
  $mutexScope = ([BitConverter]::ToString($mutexAlgorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($privateRoot.ToLowerInvariant())))).Replace('-', '').Substring(0, 12)
} finally {
  $mutexAlgorithm.Dispose()
}
$mutexName = "Local\PCFileBridgeVolumeMonitor-$Role-$mutexScope"
$mutex = New-Object Threading.Mutex($false, $mutexName)
$ownsMutex = $false
try {
  try { $ownsMutex = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
  if (-not $ownsMutex) {
    [pscustomobject]@{ role = $Role; monitor = 'already_running' }
    exit 0
  }

  while ($true) {
    try {
      $updateArgs = @{ Role = $Role; OutputPath = $candidateConfigPath }
      if (-not [string]::IsNullOrWhiteSpace($InventoryPath)) { $updateArgs.InventoryPath = $InventoryPath }
      $update = & (Join-Path $PSScriptRoot 'Update-PCFileBridgeVolumeConfig.ps1') @updateArgs
      $candidatePath = (Resolve-Path -LiteralPath ([string]$update.config_path) -ErrorAction Stop).Path
      Invoke-CrashPoint 'candidate_written'

      $stable = if (Test-Path -LiteralPath $stableStatePath -PathType Leaf) {
        try { Get-Content -Raw -LiteralPath $stableStatePath | ConvertFrom-Json } catch { $null }
      } else { $null }
      $topologyHash = [string]$update.topology_sha256
      $stableCount = if ($null -ne $stable -and [string]$stable.topology_sha256 -ceq $topologyHash) { [int]$stable.count + 1 } else { 1 }
      Set-PrivateStateFile -Path $stableStatePath -Value (([ordered]@{ topology_sha256 = $topologyHash; count = $stableCount } | ConvertTo-Json -Compress) + [Environment]::NewLine) -Encoding ([Text.Encoding]::ASCII)
      if ($stableCount -lt $StableSnapshots) {
        [pscustomobject]@{
          role = $Role
          changed = [bool]$update.changed
          fixed_volume_count = [int]$update.fixed_volume_count
          root_ids = @($update.root_ids)
          stable_snapshot_count = $stableCount
          runtime_action = 'stabilizing'
        }
        if ($Once) { break }
        Start-Sleep -Seconds $PollSeconds
        continue
      }

      if ($SkipConnect) {
        [pscustomobject]@{
          role = $Role
          changed = [bool]$update.changed
          fixed_volume_count = [int]$update.fixed_volume_count
          root_ids = @($update.root_ids)
          stable_snapshot_count = $stableCount
          runtime_action = 'skipped'
        }
        if ($Once) { break }
        Start-Sleep -Seconds $PollSeconds
        continue
      }

      $candidateHash = Get-CombinedHash -ConfigHash (Get-FileSha256 $candidatePath) -TopologyHash $topologyHash
      $appliedHash = if (Test-Path -LiteralPath $appliedHashPath -PathType Leaf) { [IO.File]::ReadAllText($appliedHashPath).Trim().ToLowerInvariant() } else { '' }
      $lastGoodHash = if (Test-Path -LiteralPath $lastGoodHashPath -PathType Leaf) { [IO.File]::ReadAllText($lastGoodHashPath).Trim().ToLowerInvariant() } else { '' }
      $rejectedHash = if (Test-Path -LiteralPath $rejectedHashPath -PathType Leaf) { [IO.File]::ReadAllText($rejectedHashPath).Trim().ToLowerInvariant() } else { '' }
      $status = Get-RuntimeStatus
      $runtimeReady = $null -ne $status -and [bool]$status.process_running -and [bool]$status.healthy -and [bool]$status.ready
      $runtimeAction = 'none'
      $rollbackApplied = $false

      if ($rejectedHash -ceq $candidateHash -and -not [string]::IsNullOrWhiteSpace($rejectedHash)) {
        if (-not $runtimeReady -and (Test-Path -LiteralPath $lastGoodConfigPath -PathType Leaf)) {
          Copy-Item -LiteralPath $lastGoodConfigPath -Destination $ConfigPath -Force
          $tunnelId = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $TunnelIdPath -ErrorAction Stop).Path).Trim()
          & $resolvedConnectScript -Role $Role -TunnelId $tunnelId -ConfigPath $ConfigPath -EnableFullDrive | Out-Null
          Invoke-LocalMcpProbe -Path $ConfigPath -ExpectedRoots @((Get-Content -Raw -LiteralPath $ConfigPath | ConvertFrom-Json).roots.id)
          $runtimeReady = $true
        }
        $runtimeAction = 'rejected_skipped_lkg_active'
      } elseif ($appliedHash -ceq $candidateHash -and $runtimeReady -and (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
        Invoke-LocalMcpProbe -Path $ConfigPath -ExpectedRoots @($update.root_ids)
        if ($lastGoodHash -cne $candidateHash) {
          Copy-Item -LiteralPath $ConfigPath -Destination $lastGoodConfigPath -Force
          Set-PrivateStateFile -Path $lastGoodConfigPath -Value ([IO.File]::ReadAllText($lastGoodConfigPath, [Text.Encoding]::UTF8)) -Encoding (New-Object Text.UTF8Encoding($false))
          Set-PrivateStateFile -Path $lastGoodHashPath -Value ($candidateHash + [Environment]::NewLine) -Encoding ([Text.Encoding]::ASCII)
          $runtimeAction = 'crash_recovered_lkg_promoted'
        }
      } else {
        if ($null -ne $status -and [bool]$status.process_running) {
          & $tunnelClient runtimes stop $alias --json | Out-Null
          if ($LASTEXITCODE -ne 0) { throw 'TUNNEL_STOP_FAILED' }
          Invoke-CrashPoint 'after_stop'
        }
        Copy-Item -LiteralPath $candidatePath -Destination $ConfigPath -Force
        $tunnelId = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $TunnelIdPath -ErrorAction Stop).Path).Trim()
        if ($tunnelId -cnotmatch '^tunnel_[A-Za-z0-9_-]{8,}$') { throw 'TUNNEL_ID_INVALID' }
        try {
          & $resolvedConnectScript -Role $Role -TunnelId $tunnelId -ConfigPath $ConfigPath -EnableFullDrive | Out-Null
          Invoke-CrashPoint 'after_candidate_start'
          Invoke-LocalMcpProbe -Path $ConfigPath -ExpectedRoots @($update.root_ids)
          $postStatus = Get-RuntimeStatus
          if ($null -eq $postStatus -or -not [bool]$postStatus.process_running -or -not [bool]$postStatus.healthy -or -not [bool]$postStatus.ready) { throw 'TUNNEL_RUNTIME_NOT_READY' }
          Invoke-CrashPoint 'before_applied_hash'
          Set-PrivateStateFile -Path $appliedHashPath -Value ($candidateHash + [Environment]::NewLine) -Encoding ([Text.Encoding]::ASCII)
          Invoke-CrashPoint 'after_applied_hash'
          Invoke-CrashPoint 'before_lkg_promotion'
          Copy-Item -LiteralPath $ConfigPath -Destination $lastGoodConfigPath -Force
          Set-PrivateStateFile -Path $lastGoodConfigPath -Value ([IO.File]::ReadAllText($lastGoodConfigPath, [Text.Encoding]::UTF8)) -Encoding (New-Object Text.UTF8Encoding($false))
          Set-PrivateStateFile -Path $lastGoodHashPath -Value ($candidateHash + [Environment]::NewLine) -Encoding ([Text.Encoding]::ASCII)
          if (Test-Path -LiteralPath $rejectedHashPath) { Remove-Item -LiteralPath $rejectedHashPath -Force }
          $runtimeAction = 'candidate_promoted'
          $runtimeReady = $true
        } catch {
          if ($_.Exception.Message -like 'SIMULATED_CRASH_*') { throw }
          if (-not (Test-Path -LiteralPath $lastGoodConfigPath -PathType Leaf) -or -not (Test-Path -LiteralPath $lastGoodHashPath -PathType Leaf)) { throw 'RUNTIME_ROLLBACK_UNAVAILABLE' }
          & $tunnelClient runtimes stop $alias --json 2>$null | Out-Null
          Copy-Item -LiteralPath $lastGoodConfigPath -Destination $ConfigPath -Force
          $lastGoodHash = [IO.File]::ReadAllText($lastGoodHashPath).Trim().ToLowerInvariant()
          & $resolvedConnectScript -Role $Role -TunnelId $tunnelId -ConfigPath $ConfigPath -EnableFullDrive | Out-Null
          $lkgRoots = @((Get-Content -Raw -LiteralPath $ConfigPath | ConvertFrom-Json).roots.id)
          Invoke-LocalMcpProbe -Path $ConfigPath -ExpectedRoots $lkgRoots
          Set-PrivateStateFile -Path $appliedHashPath -Value ($lastGoodHash + [Environment]::NewLine) -Encoding ([Text.Encoding]::ASCII)
          Set-PrivateStateFile -Path $rejectedHashPath -Value ($candidateHash + [Environment]::NewLine) -Encoding ([Text.Encoding]::ASCII)
          $runtimeAction = 'candidate_failed_rolled_back'
          $runtimeReady = $true
          $rollbackApplied = $true
        } finally { $tunnelId = $null }
      }

      [pscustomobject]@{
        role = $Role
        changed = [bool]$update.changed
        fixed_volume_count = [int]$update.fixed_volume_count
        blocked_volume_count = [int]$update.blocked_volume_count
        root_ids = @($update.root_ids)
        stable_snapshot_count = $stableCount
        runtime_action = $runtimeAction
        runtime_ready = $runtimeReady
        rollback_applied = $rollbackApplied
      }
    } catch {
      if ($Once) { throw }
      Write-Error -ErrorAction Continue -Message ('PC_FILEBRIDGE_VOLUME_MONITOR_RETRY: ' + $_.Exception.Message)
    }

    if ($Once) { break }
    Start-Sleep -Seconds $PollSeconds
  }
} finally {
  if ($ownsMutex) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
