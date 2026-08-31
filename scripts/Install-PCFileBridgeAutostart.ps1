[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^tunnel_[A-Za-z0-9_-]{8,}$')]
  [string]$TunnelId,
  [string]$TaskName = 'PC FileBridge Tunnel'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  throw 'The scheduled task already exists; this installer never replaces it.'
}

$connectScript = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'Connect-PCFileBridgeTunnel.ps1') -ErrorAction Stop).Path
$account = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -TunnelId "{1}"' -f $connectScript, $TunnelId
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments -WorkingDirectory ([IO.Path]::GetDirectoryName($connectScript))
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $account
$watchdogTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$principal = New-ScheduledTaskPrincipal -UserId $account -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -Compatibility Win8 -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -DontStopOnIdleEnd -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($logonTrigger, $watchdogTrigger) -Principal $principal -Settings $settings -Description 'Starts the private OpenAI Secure MCP Tunnel for PC FileBridge after user logon and retries stopped runtimes every five minutes.' | Out-Null
Write-Output "AUTOSTART_INSTALLED task=$TaskName overwrite=false"
