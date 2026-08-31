[CmdletBinding()]
param(
  [ValidateSet('pc-local', 'laptop-local')]
  [string]$Role = 'pc-local',
  [string]$TaskName = '',
  [ValidateRange(5, 3600)]
  [int]$PollSeconds = 15,
  [string]$RuntimeLocalAppData = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Role = $Role.ToLowerInvariant()

if ([string]::IsNullOrWhiteSpace($TaskName)) {
  $TaskName = if ($Role -ceq 'pc-local') { 'PC FileBridge PC Local' } else { 'PC FileBridge Laptop Local' }
}
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  throw 'The scheduled task already exists; this installer never replaces it.'
}

$taskScript = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'Connect-PCFileBridgeRoleTunnel-Task.ps1') -ErrorAction Stop).Path
$account = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$argumentParts = @(
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy', 'Bypass',
  '-File', ('"' + $taskScript + '"'),
  '-Role', $Role,
  '-PollSeconds', [string]$PollSeconds
)
if (-not [string]::IsNullOrWhiteSpace($RuntimeLocalAppData)) {
  if (-not [IO.Path]::IsPathRooted($RuntimeLocalAppData)) { throw 'RUNTIME_LOCALAPPDATA_MUST_BE_ABSOLUTE' }
  $runtimeRoot = [IO.Path]::GetFullPath($RuntimeLocalAppData)
  if (-not (Test-Path -LiteralPath $runtimeRoot -PathType Container)) { throw 'RUNTIME_LOCALAPPDATA_UNAVAILABLE' }
  $argumentParts += @('-RuntimeLocalAppData', ('"' + $runtimeRoot + '"'))
}
$arguments = $argumentParts -join ' '
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments -WorkingDirectory ([IO.Path]::GetDirectoryName($taskScript))
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $account
$watchdogTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$principal = New-ScheduledTaskPrincipal -UserId $account -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -Compatibility Win8 -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -DontStopOnIdleEnd -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($logonTrigger, $watchdogTrigger) -Principal $principal -Settings $settings -Description "Starts the $Role PC FileBridge auto-volume monitor after user logon and retries stopped runtimes every five minutes." | Out-Null
Write-Output "ROLE_AUTOSTART_INSTALLED task=$TaskName role=$Role overwrite=false"
