[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('pc-local', 'laptop-local')]
  [string]$Role,
  [string]$InventoryPath = '',
  [string]$ApprovalRegistryPath = ''
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$argsMap = @{ Role = $Role; CandidatesOnly = $true }
if (-not [string]::IsNullOrWhiteSpace($InventoryPath)) { $argsMap.InventoryPath = $InventoryPath }
if (-not [string]::IsNullOrWhiteSpace($ApprovalRegistryPath)) { $argsMap.ApprovalRegistryPath = $ApprovalRegistryPath }
& (Join-Path $PSScriptRoot 'Update-PCFileBridgeVolumeConfig.ps1') @argsMap
