[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('pc-local', 'laptop-local')]
  [string]$Role,
  [Parameter(Mandatory = $true)]
  [ValidateSet('Armed', 'Locked')]
  [string]$State,
  [string]$Destination = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Destination)) {
  $Destination = Join-Path $env:LOCALAPPDATA "PCFileBridge\private\$Role.gate"
}
$path = [IO.Path]::GetFullPath($Destination)
$directory = [IO.Path]::GetDirectoryName($path)
if ([string]::IsNullOrWhiteSpace($directory)) { throw 'GATE_PATH_INVALID' }
[IO.Directory]::CreateDirectory($directory) | Out-Null

$account = [Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $directory '/inheritance:r' '/grant:r' "${account}:(OI)(CI)(F)" 'SYSTEM:(OI)(CI)(F)' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'GATE_DIRECTORY_ACL_FAILED' }

$value = if ($State -ceq 'Armed') { "ARMED:$Role`n" } else { "LOCKED:$Role`n" }
$temp = "$path.tmp"
[IO.File]::WriteAllText($temp, $value, [Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $temp -Destination $path -Force
& icacls.exe $path '/inheritance:r' '/grant:r' "${account}:(R,W)" 'SYSTEM:(F)' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'GATE_FILE_ACL_FAILED' }

[pscustomobject]@{
  role = $Role
  state = $State.ToLowerInvariant()
} | ConvertTo-Json
