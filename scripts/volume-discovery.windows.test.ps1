[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$tempRoot = Join-Path $tempBase ('pc-filebridge-volume-test-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($tempRoot) | Out-Null
$resolvedTemp = [IO.Path]::GetFullPath($tempRoot)
if (-not $resolvedTemp.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) { throw 'TEMP_SCOPE_INVALID' }
$encoding = New-Object Text.UTF8Encoding($false)
$previousLocalAppData = $env:LOCALAPPDATA

function Write-Json([string]$Path, [object]$Value) {
  [IO.File]::WriteAllText($Path, (($Value | ConvertTo-Json -Depth 12) + [Environment]::NewLine), $encoding)
}

function Assert-Throws([scriptblock]$Action, [string]$ExpectedCode) {
  try { & $Action } catch {
    if ($_.Exception.Message -ceq $ExpectedCode) { return }
    throw
  }
  throw "Expected $ExpectedCode"
}

function New-VolumeFixture(
  [string]$DeviceID,
  [int]$DriveType = 3,
  [string]$VolumeName = 'Fixture',
  [string]$BusType = 'NVMe',
  [string]$FileSystem = 'NTFS',
  [string]$HealthStatus = 'Healthy',
  [string]$IdentityToken = '',
  [bool]$Online = $true
) {
  $token = if ([string]::IsNullOrWhiteSpace($IdentityToken)) { $DeviceID.Substring(0, 1).ToLowerInvariant() } else { $IdentityToken }
  [ordered]@{
    DeviceID = $DeviceID
    DriveType = $DriveType
    VolumeName = $VolumeName
    VolumeSerialNumber = "serial-$token"
    FileSystem = $FileSystem
    HealthStatus = $HealthStatus
    BusType = $BusType
    DiskUniqueId = "disk-$token"
    PartitionUniqueId = "partition-$token"
    VolumeUniqueId = "volume-$token"
    Online = $Online
  }
}

try {
  $env:LOCALAPPDATA = Join-Path $tempRoot 'localappdata'
  $privateRoot = Join-Path $env:LOCALAPPDATA 'PCFileBridge\private'
  [IO.Directory]::CreateDirectory($privateRoot) | Out-Null
  $registry = Join-Path $privateRoot 'volume-approvals.pc-local.json'
  $inventory = Join-Path $tempRoot 'inventory.json'
  $output = Join-Path $tempRoot 'roots.auto.json'
  $missingIdentity = New-VolumeFixture -DeviceID 'M:' -BusType 'SATA'
  $missingIdentity.DiskUniqueId = ''
  Write-Json -Path $inventory -Value ([ordered]@{ volumes = @(
    (New-VolumeFixture -DeviceID 'E:' -VolumeName 'LABS' -BusType 'File Backed Virtual'),
    (New-VolumeFixture -DeviceID 'C:' -VolumeName 'System' -BusType 'NVMe'),
    (New-VolumeFixture -DeviceID 'R:' -DriveType 2 -VolumeName 'Removable' -BusType 'USB'),
    (New-VolumeFixture -DeviceID 'D:' -VolumeName 'Data' -BusType 'SATA'),
    (New-VolumeFixture -DeviceID 'U:' -VolumeName 'USB-fixed' -BusType 'USB'),
    (New-VolumeFixture -DeviceID 'X:' -VolumeName 'WrongFS' -BusType 'SATA' -FileSystem 'exFAT'),
    (New-VolumeFixture -DeviceID 'Q:' -VolumeName 'ReFS' -BusType 'SATA' -FileSystem 'ReFS'),
    (New-VolumeFixture -DeviceID 'Y:' -VolumeName 'Unhealthy' -BusType 'SATA' -HealthStatus 'Unhealthy'),
    (New-VolumeFixture -DeviceID 'Z:' -VolumeName 'Network' -BusType 'Network'),
    $missingIdentity
  ) })

  $candidateSet = & (Join-Path $PSScriptRoot 'Get-PCFileBridgeVolumeCandidates.ps1') -Role pc-local -InventoryPath $inventory -ApprovalRegistryPath $registry
  $virtual = @($candidateSet.candidates | Where-Object { $_.current_drive_letter -ceq 'E' })
  if ($virtual.Count -ne 1 -or $virtual[0].reason -cne 'OPERATOR_APPROVAL_REQUIRED') { throw 'VIRTUAL_AUTO_ALLOW_NOT_BLOCKED' }
  $usb = @($candidateSet.candidates | Where-Object { $_.current_drive_letter -ceq 'U' })
  if ($usb.Count -ne 1 -or $usb[0].reason -cne 'OPERATOR_APPROVAL_REQUIRED') { throw 'USB_FIXED_AUTO_ALLOW_NOT_BLOCKED' }
  $refs = @($candidateSet.candidates | Where-Object { $_.current_drive_letter -ceq 'Q' })
  if ($refs.Count -ne 1 -or $refs[0].reason -cne 'UNSUPPORTED_FILESYSTEM') { throw 'REFS_NOT_AUTO_DISABLED' }
  $missing = @($candidateSet.candidates | Where-Object { $_.current_drive_letter -ceq 'M' })
  if ($missing.Count -ne 1 -or $missing[0].reason -cne 'VOLUME_IDENTITY_UNAVAILABLE') { throw 'MISSING_IDENTITY_NOT_BLOCKED' }

  $first = & (Join-Path $PSScriptRoot 'Update-PCFileBridgeVolumeConfig.ps1') -Role pc-local -OutputPath $output -InventoryPath $inventory -ApprovalRegistryPath $registry
  if ((@($first.root_ids) -join ',') -cne 'pc-c,pc-d') { throw 'AUTO_POLICY_FILTER_FAILED' }
  if ([int]$first.blocked_volume_count -ne 8) { throw 'VOLUME_POLICY_BLOCK_COUNT_FAILED' }

  $virtualId = [string]$virtual[0].volume_id
  & (Join-Path $PSScriptRoot 'Approve-PCFileBridgeVolume.ps1') -Role pc-local -VolumeId $virtualId -BusType 'File Backed Virtual' -Reason 'task-owned live VHDX verification fixture' -RegistryPath $registry -Confirm:$false | Out-Null
  $approved = & (Join-Path $PSScriptRoot 'Update-PCFileBridgeVolumeConfig.ps1') -Role pc-local -OutputPath $output -InventoryPath $inventory -ApprovalRegistryPath $registry
  if ((@($approved.root_ids) -join ',') -cne 'pc-c,pc-d,pc-e') { throw 'APPROVED_VIRTUAL_NOT_ACCEPTED' }
  $config = Get-Content -Raw -LiteralPath $output | ConvertFrom-Json
  $rootE = @($config.roots | Where-Object { $_.id -ceq 'pc-e' })
  if ($rootE.Count -ne 1 -or [string]$rootE[0].volume_id -cne $virtualId -or [string]$rootE[0].host_id -cne 'pc-main') { throw 'ROOT_METADATA_INVALID' }
  if ($rootE[0].PSObject.Properties.Name -contains 'DiskUniqueId') { throw 'RAW_IDENTIFIER_EXPOSED' }
  $registryInfo = New-Object IO.FileInfo($registry)
  $acl = if ($PSVersionTable.PSEdition -ceq 'Core') {
    [System.IO.FileSystemAclExtensions]::GetAccessControl($registryInfo)
  } else {
    $registryInfo.GetAccessControl()
  }
  if (-not $acl.AreAccessRulesProtected) { throw 'APPROVAL_REGISTRY_ACL_NOT_PROTECTED' }

  $same = & (Join-Path $PSScriptRoot 'Update-PCFileBridgeVolumeConfig.ps1') -Role pc-local -OutputPath $output -InventoryPath $inventory -ApprovalRegistryPath $registry
  if ([bool]$same.changed) { throw 'UNCHANGED_INVENTORY_REWROTE_CONFIG' }

  $remount = Join-Path $tempRoot 'remount.json'
  Write-Json -Path $remount -Value ([ordered]@{ volumes = @(
    (New-VolumeFixture -DeviceID 'C:' -VolumeName 'System' -BusType 'NVMe'),
    (New-VolumeFixture -DeviceID 'D:' -VolumeName 'Data' -BusType 'SATA'),
    (New-VolumeFixture -DeviceID 'F:' -VolumeName 'LABS' -BusType 'File Backed Virtual' -IdentityToken 'e')
  ) })
  $second = & (Join-Path $PSScriptRoot 'Update-PCFileBridgeVolumeConfig.ps1') -Role pc-local -OutputPath $output -InventoryPath $remount -ApprovalRegistryPath $registry
  $remountConfig = Get-Content -Raw -LiteralPath $output | ConvertFrom-Json
  $rootF = @($remountConfig.roots | Where-Object { $_.id -ceq 'pc-f' })
  if ($rootF.Count -ne 1 -or [string]$rootF[0].volume_id -cne $virtualId) { throw 'LETTER_CHANGE_CHANGED_VOLUME_ID' }
  if ([string]$second.topology_sha256 -ceq [string]$approved.topology_sha256) { throw 'LETTER_CHANGE_DID_NOT_CHANGE_TOPOLOGY' }

  $collision = Join-Path $tempRoot 'collision.json'
  Write-Json -Path $collision -Value ([ordered]@{ volumes = @(
    (New-VolumeFixture -DeviceID 'C:' -BusType 'NVMe' -IdentityToken 'same'),
    (New-VolumeFixture -DeviceID 'D:' -BusType 'SATA' -IdentityToken 'same')
  ) })
  Assert-Throws -ExpectedCode 'VOLUME_IDENTITY_COLLISION' -Action {
    & (Join-Path $PSScriptRoot 'Update-PCFileBridgeVolumeConfig.ps1') -Role pc-local -OutputPath (Join-Path $tempRoot 'collision-output.json') -InventoryPath $collision -ApprovalRegistryPath $registry | Out-Null
  }

  & (Join-Path $PSScriptRoot 'Revoke-PCFileBridgeVolumeApproval.ps1') -Role pc-local -VolumeId $virtualId -RegistryPath $registry -Confirm:$false | Out-Null
  $revoked = & (Join-Path $PSScriptRoot 'Update-PCFileBridgeVolumeConfig.ps1') -Role pc-local -OutputPath $output -InventoryPath $inventory -ApprovalRegistryPath $registry
  if ((@($revoked.root_ids) -join ',') -cne 'pc-c,pc-d') { throw 'REVOKED_VOLUME_REMAINED' }

  $missingRequired = Join-Path $tempRoot 'missing-c.json'
  Write-Json -Path $missingRequired -Value ([ordered]@{ volumes = @((New-VolumeFixture -DeviceID 'D:' -BusType 'SATA')) })
  Assert-Throws -ExpectedCode 'ROOT_ROLE_MISMATCH' -Action {
    & (Join-Path $PSScriptRoot 'Update-PCFileBridgeVolumeConfig.ps1') -Role pc-local -OutputPath (Join-Path $tempRoot 'missing-c-output.json') -InventoryPath $missingRequired -ApprovalRegistryPath $registry | Out-Null
  }

  Write-Output 'VOLUME_DISCOVERY_WINDOWS_TEST_PASS stable_id=pass letter_change=pass topology=pass usb_fixed=blocked refs=disabled approval=pass revoke=pass collision=blocked acl=pass'
} finally {
  $env:LOCALAPPDATA = $previousLocalAppData
  if (Test-Path -LiteralPath $resolvedTemp) { Remove-Item -LiteralPath $resolvedTemp -Recurse -Force }
}
