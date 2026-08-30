[CmdletBinding()]
param(
  [ValidateSet('pc-local', 'laptop-local')]
  [string]$Role = 'pc-local',
  [ValidateRange(5, 3600)]
  [int]$PollSeconds = 15,
  [string]$RuntimeLocalAppData = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$previousLocalAppData = $env:LOCALAPPDATA
try {
  if (-not [string]::IsNullOrWhiteSpace($RuntimeLocalAppData)) {
    if (-not [IO.Path]::IsPathRooted($RuntimeLocalAppData)) { throw 'RUNTIME_LOCALAPPDATA_MUST_BE_ABSOLUTE' }
    $runtimeRoot = [IO.Path]::GetFullPath($RuntimeLocalAppData)
    if (-not (Test-Path -LiteralPath $runtimeRoot -PathType Container)) { throw 'RUNTIME_LOCALAPPDATA_UNAVAILABLE' }
    $env:LOCALAPPDATA = $runtimeRoot
  }
  & (Join-Path $PSScriptRoot 'Start-PCFileBridgeVolumeMonitor.ps1') -Role $Role -PollSeconds $PollSeconds
} finally {
  $env:LOCALAPPDATA = $previousLocalAppData
}
