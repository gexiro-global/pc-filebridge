[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('pc-local', 'laptop-local')]
  [string]$Role,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^vol-[a-f0-9]{16}$')]
  [string]$VolumeId,
  [string]$RegistryPath = ''
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($RegistryPath)) {
  $RegistryPath = Join-Path $env:LOCALAPPDATA "PCFileBridge\private\volume-approvals.$Role.json"
}
$fullPath = (Resolve-Path -LiteralPath $RegistryPath -ErrorAction Stop).Path
$registry = Get-Content -Raw -LiteralPath $fullPath | ConvertFrom-Json
if ([int]$registry.version -ne 1) { throw 'APPROVAL_REGISTRY_INVALID' }
$before = @($registry.approvals)
$after = @($before | Where-Object { [string]$_.volume_id -cne $VolumeId })
if ($after.Count -eq $before.Count) { throw 'VOLUME_APPROVAL_NOT_FOUND' }
if (-not $PSCmdlet.ShouldProcess("$VolumeId on $Role", 'Revoke volume approval')) { return }
$value = [ordered]@{ version = 1; approvals = $after }
$directory = Split-Path -Parent $fullPath
$temp = Join-Path $directory ('.pcfb-approval-' + [Guid]::NewGuid().ToString('N') + '.tmp')
try {
  [IO.File]::WriteAllText($temp, (($value | ConvertTo-Json -Depth 8) + [Environment]::NewLine), (New-Object Text.UTF8Encoding($false)))
  $current = [Security.Principal.WindowsIdentity]::GetCurrent()
  & icacls.exe $temp /inheritance:r /grant:r ('*' + $current.User.Value + ':(F)') '*S-1-5-18:(F)' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'APPROVAL_REGISTRY_ACL_FAILED' }
  Move-Item -LiteralPath $temp -Destination $fullPath -Force
} finally {
  if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force }
}
[pscustomobject]@{ role = $Role; volume_id = $VolumeId; revoked = $true; registry_path = $fullPath }
