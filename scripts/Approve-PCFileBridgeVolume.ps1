[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('pc-local', 'laptop-local')]
  [string]$Role,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^vol-[a-f0-9]{16}$')]
  [string]$VolumeId,
  [Parameter(Mandatory = $true)]
  [ValidateSet('File Backed Virtual', 'USB', 'SD', 'MMC', '1394', 'Removable')]
  [string]$BusType,
  [Parameter(Mandatory = $true)]
  [ValidateLength(4, 160)]
  [string]$Reason,
  [string]$RegistryPath = ''
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($RegistryPath)) {
  $RegistryPath = Join-Path $env:LOCALAPPDATA "PCFileBridge\private\volume-approvals.$Role.json"
}
$fullPath = [IO.Path]::GetFullPath($RegistryPath)
$directory = Split-Path -Parent $fullPath
[IO.Directory]::CreateDirectory($directory) | Out-Null
$registry = if (Test-Path -LiteralPath $fullPath -PathType Leaf) {
  Get-Content -Raw -LiteralPath $fullPath | ConvertFrom-Json
} else {
  [pscustomobject]@{ version = 1; approvals = @() }
}
if ([int]$registry.version -ne 1) { throw 'APPROVAL_REGISTRY_INVALID' }
$items = @($registry.approvals)
if (@($items | Where-Object { [string]$_.volume_id -ceq $VolumeId }).Count -gt 0) { throw 'VOLUME_ALREADY_APPROVED' }
if (-not $PSCmdlet.ShouldProcess("$VolumeId on $Role", "Approve bus type $BusType")) { return }
$items += [ordered]@{
  volume_id = $VolumeId
  allowed_bus_types = @($BusType)
  reason = $Reason.Trim()
  approved_at_utc = (Get-Date).ToUniversalTime().ToString('o')
}
$value = [ordered]@{ version = 1; approvals = @($items | Sort-Object volume_id) }
$temp = Join-Path $directory ('.pcfb-approval-' + [Guid]::NewGuid().ToString('N') + '.tmp')
try {
  [IO.File]::WriteAllText($temp, (($value | ConvertTo-Json -Depth 8) + [Environment]::NewLine), (New-Object Text.UTF8Encoding($false)))
  $current = [Security.Principal.WindowsIdentity]::GetCurrent()
  $fileInfo = New-Object IO.FileInfo($temp)
  $acl = New-Object Security.AccessControl.FileSecurity
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sidValue in @($current.User.Value, 'S-1-5-18')) {
    $sid = New-Object Security.Principal.SecurityIdentifier($sidValue)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule(
      $sid,
      [Security.AccessControl.FileSystemRights]::FullControl,
      [Security.AccessControl.InheritanceFlags]::None,
      [Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow
    )
    [void]$acl.AddAccessRule($rule)
  }
  if ($PSVersionTable.PSEdition -ceq 'Core') {
    [System.IO.FileSystemAclExtensions]::SetAccessControl($fileInfo, $acl)
  } else {
    $fileInfo.SetAccessControl($acl)
  }
  Move-Item -LiteralPath $temp -Destination $fullPath -Force
} finally {
  if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force }
}
[pscustomobject]@{ role = $Role; volume_id = $VolumeId; bus_type = $BusType; approved = $true; registry_path = $fullPath }
