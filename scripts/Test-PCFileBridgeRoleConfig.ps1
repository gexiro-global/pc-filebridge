[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('pc-local', 'laptop-local')]
  [string]$Role,
  [Parameter(Mandatory = $true)]
  [string]$ConfigPath,
  [string]$ContractPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($ContractPath)) {
  $ContractPath = Join-Path $PSScriptRoot '..\config\tunnel-roles.json'
}
$resolvedContract = (Resolve-Path -LiteralPath $ContractPath -ErrorAction Stop).Path
$resolvedConfig = (Resolve-Path -LiteralPath $ConfigPath -ErrorAction Stop).Path
$contract = Get-Content -Raw -LiteralPath $resolvedContract | ConvertFrom-Json
$config = Get-Content -Raw -LiteralPath $resolvedConfig | ConvertFrom-Json
$roleContract = @($contract.roles | Where-Object { $_.id -ceq $Role })
if ($roleContract.Count -ne 1) { throw 'ROLE_CONTRACT_INVALID' }
$roleContract = $roleContract[0]

$roots = @($config.roots)
if ($roots.Count -lt 1 -or $roots.Count -gt 26) { throw 'ROOT_ROLE_MISMATCH' }
$configuredIds = @($roots | ForEach-Object { [string]$_.id })
if (@($configuredIds | Sort-Object -Unique).Count -ne $configuredIds.Count) {
  throw 'ROOT_ROLE_MISMATCH'
}

$allowedIds = @($roleContract.rootIds | ForEach-Object { [string]$_ })
$requiredIds = @($roleContract.requiredRootIds | ForEach-Object { [string]$_ })
$discoveryProperty = $roleContract.PSObject.Properties['volumeDiscovery']
$discoveryEnabled = $null -ne $discoveryProperty -and [bool]$discoveryProperty.Value.enabled
$prefix = if ($discoveryEnabled) { [string]$discoveryProperty.Value.rootIdPrefix } else { '' }
if ($discoveryEnabled) {
  if ($prefix -cnotmatch '^[a-z][a-z0-9-]{0,29}-$') { throw 'ROLE_CONTRACT_INVALID' }
  if ([int]$discoveryProperty.Value.driveType -ne 3) { throw 'ROLE_CONTRACT_INVALID' }
}

foreach ($entry in $roots) {
  $id = [string]$entry.id
  $rawPath = [string]$entry.path
  if (-not [bool]$entry.read -or -not [bool]$entry.create) { throw 'ROOT_ROLE_MISMATCH' }
  if ($rawPath -cnotmatch '^(?<letter>[A-Za-z]):\\$') { throw 'ROOT_ROLE_MISMATCH' }
  $driveLetter = $Matches.letter.ToLowerInvariant()
  $metadataPresent = $null -ne $entry.PSObject.Properties['volume_id']
  if ($metadataPresent) {
    if (
      [string]$entry.host_id -cne [string]$roleContract.hostId -or
      [string]$entry.volume_id -cnotmatch '^vol-[a-f0-9]{16}$' -or
      [string]$entry.current_drive_letter -cne $driveLetter.ToUpperInvariant() -or
      [string]$entry.filesystem -cne 'NTFS' -or
      [string]::IsNullOrWhiteSpace([string]$entry.bus_type) -or
      -not [bool]$entry.online -or
      -not [bool]$entry.auto_discovered
    ) {
      throw 'ROOT_METADATA_INVALID'
    }
  }

  $staticPathProperty = $roleContract.rootPaths.PSObject.Properties[$id]
  if ($allowedIds -ccontains $id -and $null -ne $staticPathProperty) {
    $expectedPath = [string]$staticPathProperty.Value
    if (-not [string]::Equals($rawPath, $expectedPath, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'ROOT_ROLE_MISMATCH'
    }
    continue
  }

  if (-not $discoveryEnabled) { throw 'ROOT_ROLE_MISMATCH' }
  $escapedPrefix = [Regex]::Escape($prefix)
  if ($id -cnotmatch "^$escapedPrefix(?<suffix>[a-z])$") { throw 'ROOT_ROLE_MISMATCH' }
  if ($Matches.suffix -cne $driveLetter) { throw 'ROOT_ROLE_MISMATCH' }
}

foreach ($requiredId in $requiredIds) {
  if ($configuredIds -cnotcontains $requiredId) { throw 'ROOT_ROLE_MISMATCH' }
}

$expectedOrder = if ($discoveryEnabled) {
  @($configuredIds | Sort-Object)
} else {
  @($allowedIds | Where-Object { $configuredIds -ccontains $_ })
}
if (($configuredIds -join [char]0) -cne ($expectedOrder -join [char]0)) {
  throw 'ROOT_ROLE_MISMATCH'
}

[pscustomobject]@{
  role = $Role
  alias = [string]$roleContract.alias
  expectedTunnelName = [string]$roleContract.expectedTunnelName
  gateRequired = [bool]$roleContract.gateRequired
  configuredIds = $configuredIds
  usesDriveRoot = $true
  discoveryEnabled = $discoveryEnabled
}
