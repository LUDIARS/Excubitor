[CmdletBinding()]
param(
  [string]$TaskName = 'Excubitor-Package-Audit-Daily',
  [ValidatePattern('^(?:[01]\d|2[0-3]):[0-5]\d$')]
  [string]$At = '09:00'
)

$ErrorActionPreference = 'Stop'
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $Utf8NoBom
[Console]::OutputEncoding = $Utf8NoBom
$OutputEncoding = $Utf8NoBom
$PSDefaultParameterValues['*:Encoding'] = 'utf8'

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$runnerPath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'run-package-audit.ps1')).Path
$cliPath = Join-Path $repoRoot 'dist\update\package-audit\cli.js'
if (-not (Test-Path -LiteralPath $cliPath -PathType Leaf)) {
  throw "Package audit CLI is not built: $cliPath. Run npm run build first."
}

$powerShellPath = (Get-Command powershell.exe -ErrorAction Stop).Source
$actionArguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$runnerPath`""
$action = New-ScheduledTaskAction `
  -Execute $powerShellPath `
  -Argument $actionArguments `
  -WorkingDirectory $repoRoot
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$principal = New-ScheduledTaskPrincipal `
  -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
  -LogonType Interactive `
  -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Description 'Daily Excubitor npm dependency, global CLI, vulnerability, and release-note audit.' `
  -Force

Write-Output "Registered $TaskName at $At. The task is not started by this installer."
