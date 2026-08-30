[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('pc-local', 'laptop-local')]
  [string]$Role,
  [string]$OutputPath = '',
  [string]$InventoryPath = '',
  [string]$TemplatePath = '',
  [string]$ContractPath = '',
  [string]$HostId = '',
  [string]$ApprovalRegistryPath = '',
  [switch]$CandidatesOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-Sha256([string]$Value) {
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
    return ([BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
  } finally { $algorithm.Dispose() }
}

function Normalize-Identifier([object]$Value) {
  if ($null -eq $Value) { return '' }
  return (([string]$Value).Trim() -replace '\s+', '').ToLowerInvariant()
}

function Set-PrivateFileAcl([string]$Path) {
  $current = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  & icacls.exe $Path /inheritance:r /grant:r ('*' + $current.User.Value + ':(F)') '*S-1-5-18:(F)' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'PRIVATE_FILE_ACL_FAILED' }
}

function Test-PrivateFileAcl([string]$Path) {
  $fileInfo = New-Object IO.FileInfo($Path)
  $acl = if ($PSVersionTable.PSEdition -ceq 'Core') {
    [System.IO.FileSystemAclExtensions]::GetAccessControl($fileInfo)
  } else {
    $fileInfo.GetAccessControl()
  }
  if (-not $acl.AreAccessRulesProtected) { throw 'APPROVAL_REGISTRY_ACL_INVALID' }
  $allowedSids = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18')
  $rules = $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
  foreach ($rule in @($rules)) {
    $sid = $rule.IdentityReference.Value
    if ($rule.AccessControlType -eq 'Allow' -and $allowedSids -notcontains $sid) {
      throw 'APPROVAL_REGISTRY_ACL_INVALID'
    }
  }
}

$pluginRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..') -ErrorAction Stop).Path
if ([string]::IsNullOrWhiteSpace($ContractPath)) { $ContractPath = Join-Path $pluginRoot 'config\tunnel-roles.json' }
$resolvedContract = (Resolve-Path -LiteralPath $ContractPath -ErrorAction Stop).Path
$contract = Get-Content -Raw -LiteralPath $resolvedContract | ConvertFrom-Json
$roleContract = @($contract.roles | Where-Object { $_.id -ceq $Role })
if ($roleContract.Count -ne 1) { throw 'ROLE_CONTRACT_INVALID' }
$roleContract = $roleContract[0]
$discoveryProperty = $roleContract.PSObject.Properties['volumeDiscovery']
if ($null -eq $discoveryProperty -or -not [bool]$discoveryProperty.Value.enabled) { throw 'VOLUME_DISCOVERY_DISABLED' }
$driveType = [int]$discoveryProperty.Value.driveType
$rootIdPrefix = [string]$discoveryProperty.Value.rootIdPrefix
$allowedBusTypes = @($discoveryProperty.Value.allowedBusTypes | ForEach-Object { ([string]$_).Trim() })
$allowedFileSystems = @($discoveryProperty.Value.allowedFileSystems | ForEach-Object { ([string]$_).Trim() })
$requireHealthy = [bool]$discoveryProperty.Value.requireHealthy
if ([string]::IsNullOrWhiteSpace($HostId)) { $HostId = [string]$roleContract.hostId }
$HostId = $HostId.Trim().ToLowerInvariant()
if ($driveType -ne 3 -or $rootIdPrefix -cnotmatch '^[a-z][a-z0-9-]{0,29}-$' -or $HostId -cnotmatch '^[a-z][a-z0-9-]{0,63}$' -or $allowedBusTypes.Count -lt 1 -or ($allowedFileSystems -join ',') -cne 'NTFS') {
  throw 'ROLE_CONTRACT_INVALID'
}

if ([string]::IsNullOrWhiteSpace($TemplatePath)) {
  $templateName = if ($Role -ceq 'pc-local') { 'roots.pc.example.json' } else { 'roots.laptop.example.json' }
  $TemplatePath = Join-Path $pluginRoot "config\$templateName"
}
$resolvedTemplate = (Resolve-Path -LiteralPath $TemplatePath -ErrorAction Stop).Path
$template = Get-Content -Raw -LiteralPath $resolvedTemplate | ConvertFrom-Json

$privateRoot = Join-Path $env:LOCALAPPDATA 'PCFileBridge\private'
[IO.Directory]::CreateDirectory($privateRoot) | Out-Null
if ([string]::IsNullOrWhiteSpace($OutputPath)) { $OutputPath = Join-Path $privateRoot "roots.$Role.auto.json" }
if ([string]::IsNullOrWhiteSpace($ApprovalRegistryPath)) { $ApprovalRegistryPath = Join-Path $privateRoot "volume-approvals.$Role.json" }
$outputFullPath = [IO.Path]::GetFullPath($OutputPath)
$outputDirectory = Split-Path -Parent $outputFullPath
[IO.Directory]::CreateDirectory($outputDirectory) | Out-Null
$approvalFullPath = [IO.Path]::GetFullPath($ApprovalRegistryPath)

$approvals = @{}
if (Test-Path -LiteralPath $approvalFullPath -PathType Leaf) {
  Test-PrivateFileAcl -Path $approvalFullPath
  $registry = Get-Content -Raw -LiteralPath $approvalFullPath | ConvertFrom-Json
  if ([int]$registry.version -ne 1) { throw 'APPROVAL_REGISTRY_INVALID' }
  foreach ($approval in @($registry.approvals)) {
    $approvedId = ([string]$approval.volume_id).Trim().ToLowerInvariant()
    if ($approvedId -cnotmatch '^vol-[a-f0-9]{16}$' -or $approvals.ContainsKey($approvedId)) { throw 'APPROVAL_REGISTRY_INVALID' }
    $approvedBuses = @($approval.allowed_bus_types | ForEach-Object { ([string]$_).Trim() })
    if ($approvedBuses.Count -lt 1) { throw 'APPROVAL_REGISTRY_INVALID' }
    $approvals[$approvedId] = $approvedBuses
  }
}

$fixtureMode = -not [string]::IsNullOrWhiteSpace($InventoryPath)
if ($fixtureMode) {
  $resolvedInventory = (Resolve-Path -LiteralPath $InventoryPath -ErrorAction Stop).Path
  $inventoryValue = Get-Content -Raw -LiteralPath $resolvedInventory | ConvertFrom-Json
  $volumesProperty = $inventoryValue.PSObject.Properties['volumes']
  $volumes = if ($null -ne $volumesProperty) { @($volumesProperty.Value) } else { @($inventoryValue) }
} else {
  $volumes = @()
  foreach ($logical in @(Get-CimInstance -ClassName Win32_LogicalDisk -ErrorAction Stop)) {
    $deviceId = ([string]$logical.DeviceID).Trim().ToUpperInvariant()
    if ($deviceId -cnotmatch '^(?<letter>[A-Z]):$') { continue }
    $letter = $Matches.letter
    try {
      $partition = @(Get-Partition -DriveLetter $letter -ErrorAction Stop)
      if ($partition.Count -ne 1) { continue }
      $disk = Get-Disk -Number $partition[0].DiskNumber -ErrorAction Stop
      $volume = Get-Volume -DriveLetter $letter -ErrorAction Stop
      $volumes += [pscustomobject]@{
        DeviceID = $deviceId
        DriveType = [int]$logical.DriveType
        VolumeName = [string]$logical.VolumeName
        VolumeSerialNumber = [string]$logical.VolumeSerialNumber
        FileSystem = [string]$volume.FileSystem
        HealthStatus = [string]$volume.HealthStatus
        BusType = [string]$disk.BusType
        DiskUniqueId = [string]$disk.UniqueId
        PartitionUniqueId = [string]$partition[0].UniqueId
        VolumeUniqueId = [string]$volume.UniqueId
        Online = -not [bool]$disk.IsOffline
      }
    } catch { continue }
  }
}

$normalized = @()
$candidates = @()
$blockedCount = 0
$identityOwners = @{}
$hardBlockedBusTypes = @('Network', 'Optical', 'Unknown')
foreach ($volume in $volumes) {
  $deviceId = ([string]$volume.DeviceID).Trim().ToUpperInvariant()
  if ($deviceId -cnotmatch '^(?<letter>[A-Z]):$') { throw 'VOLUME_INVENTORY_INVALID' }
  $letter = $Matches.letter
  $rootPath = "${letter}:\"
  $itemDriveType = [int]$volume.DriveType
  $busType = ([string]$volume.BusType).Trim()
  $fileSystem = ([string]$volume.FileSystem).Trim()
  $healthStatus = ([string]$volume.HealthStatus).Trim()
  $onlineProperty = $volume.PSObject.Properties['Online']
  $online = if ($null -eq $onlineProperty) { $true } else { [bool]$onlineProperty.Value }
  $identityParts = @(
    (Normalize-Identifier $volume.DiskUniqueId),
    (Normalize-Identifier $volume.PartitionUniqueId),
    (Normalize-Identifier $volume.VolumeUniqueId),
    (Normalize-Identifier $volume.VolumeSerialNumber)
  )
  $identityAvailable = @($identityParts | Where-Object { [string]::IsNullOrWhiteSpace($_) }).Count -eq 0
  $volumeId = ''
  if ($identityAvailable) {
    $identityMaterial = @('pcfb-volume-id-v1', $HostId) + $identityParts
    $volumeId = 'vol-' + (Get-Sha256 -Value ($identityMaterial -join [char]0)).Substring(0, 16)
    if ($identityOwners.ContainsKey($volumeId)) { throw 'VOLUME_IDENTITY_COLLISION' }
    $identityOwners[$volumeId] = $letter
  }

  $approved = -not [string]::IsNullOrWhiteSpace($volumeId) -and $approvals.ContainsKey($volumeId) -and @($approvals[$volumeId]) -contains $busType
  $reason = 'ELIGIBLE'
  if ($itemDriveType -ne $driveType) { $reason = 'DRIVE_TYPE_BLOCKED' }
  elseif (-not $online) { $reason = 'VOLUME_OFFLINE' }
  elseif (-not $identityAvailable) { $reason = 'VOLUME_IDENTITY_UNAVAILABLE' }
  elseif ($allowedFileSystems -notcontains $fileSystem) { $reason = 'UNSUPPORTED_FILESYSTEM' }
  elseif ($requireHealthy -and $healthStatus -cne 'Healthy') { $reason = 'VOLUME_UNHEALTHY' }
  elseif ($hardBlockedBusTypes -contains $busType) { $reason = 'BUS_TYPE_BLOCKED' }
  elseif ($allowedBusTypes -notcontains $busType -and -not $approved) { $reason = 'OPERATOR_APPROVAL_REQUIRED' }
  elseif (-not $fixtureMode -and -not (Test-Path -LiteralPath $rootPath -PathType Container)) { $reason = 'VOLUME_OFFLINE' }

  $eligible = $reason -ceq 'ELIGIBLE'
  $candidates += [pscustomobject]@{
    root_id = "$rootIdPrefix$($letter.ToLowerInvariant())"
    volume_id = $volumeId
    current_drive_letter = $letter
    filesystem = $fileSystem
    bus_type = $busType
    health = $healthStatus
    online = $online
    approved = $approved
    eligible = $eligible
    reason = $reason
  }
  if (-not $eligible) { $blockedCount += 1; continue }
  if (@($normalized | Where-Object { $_.letter -ceq $letter }).Count -gt 0) { throw 'VOLUME_INVENTORY_INVALID' }
  $volumeName = ([string]$volume.VolumeName).Trim()
  if ($volumeName.Length -gt 40 -or $volumeName -cnotmatch '^[\p{L}\p{N} _.-]*$') { $volumeName = '' }
  $normalized += [pscustomobject]@{
    letter = $letter
    rootPath = $rootPath
    volumeName = $volumeName
    busType = $busType
    fileSystem = $fileSystem
    healthStatus = $healthStatus
    volumeId = $volumeId
    approved = $approved
  }
}

if ($CandidatesOnly) {
  [pscustomobject]@{ role = $Role; host_id = $HostId; candidates = @($candidates | Sort-Object current_drive_letter) }
  exit 0
}

$normalized = @($normalized | Sort-Object letter)
if ($normalized.Count -lt 1 -or $normalized.Count -gt 26) { throw 'VOLUME_INVENTORY_INVALID' }

$deviceLabel = if ($Role -ceq 'pc-local') { 'Main PC' } else { 'Laptop' }
$roots = @($normalized | ForEach-Object {
  $suffix = $_.letter.ToLowerInvariant()
  $labelSuffix = if ([string]::IsNullOrWhiteSpace($_.volumeName)) { '' } else { " - $($_.volumeName)" }
  [ordered]@{
    id = "$rootIdPrefix$suffix"
    label = "$deviceLabel $($_.letter) drive$labelSuffix"
    path = $_.rootPath
    read = $true
    create = $true
    host_id = $HostId
    volume_id = $_.volumeId
    current_drive_letter = $_.letter
    filesystem = $_.fileSystem
    bus_type = $_.busType
    online = $true
    auto_discovered = $true
  }
})
$config = [ordered]@{ version = 1; roots = $roots; limits = $template.limits }
$json = ($config | ConvertTo-Json -Depth 8) + [Environment]::NewLine
$encoding = New-Object Text.UTF8Encoding($false)
$tempPath = Join-Path $outputDirectory ('.pc-filebridge-roots-' + [Guid]::NewGuid().ToString('N') + '.tmp')

$changed = $true
if (Test-Path -LiteralPath $outputFullPath -PathType Leaf) {
  $existing = [IO.File]::ReadAllText($outputFullPath, [Text.Encoding]::UTF8)
  $changed = $existing -cne $json
}
if ($changed) {
  try {
    [IO.File]::WriteAllText($tempPath, $json, $encoding)
    & (Join-Path $PSScriptRoot 'Test-PCFileBridgeRoleConfig.ps1') -Role $Role -ConfigPath $tempPath -ContractPath $resolvedContract | Out-Null
    Set-PrivateFileAcl -Path $tempPath
    Move-Item -LiteralPath $tempPath -Destination $outputFullPath -Force
  } finally {
    if (Test-Path -LiteralPath $tempPath) { Remove-Item -LiteralPath $tempPath -Force }
  }
} else {
  & (Join-Path $PSScriptRoot 'Test-PCFileBridgeRoleConfig.ps1') -Role $Role -ConfigPath $outputFullPath -ContractPath $resolvedContract | Out-Null
  Set-PrivateFileAcl -Path $outputFullPath
}

$topologyMaterial = @($normalized | ForEach-Object {
  @($_.volumeId, $_.letter, $_.busType, $_.fileSystem, $_.healthStatus, 'online', $(if ($_.approved) { 'approved' } else { 'automatic' })) -join [char]0
}) -join [char]0x1e

[pscustomobject]@{
  role = $Role
  host_id = $HostId
  changed = $changed
  fixed_volume_count = $roots.Count
  blocked_volume_count = $blockedCount
  root_ids = @($roots | ForEach-Object { [string]$_.id })
  volume_ids = @($roots | ForEach-Object { [string]$_.volume_id })
  config_path = $outputFullPath
  topology_sha256 = Get-Sha256 -Value $topologyMaterial
}
