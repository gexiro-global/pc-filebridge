[CmdletBinding()]
param(
  [ValidateSet('pc-local', 'laptop-local')]
  [string]$Role = 'pc-local',
  [ValidateRange(5, 3600)]
  [int]$PollSeconds = 15
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

& (Join-Path $PSScriptRoot 'Start-PCFileBridgeVolumeMonitor.ps1') -Role $Role -PollSeconds $PollSeconds
