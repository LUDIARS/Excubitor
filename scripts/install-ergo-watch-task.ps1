[CmdletBinding()]
param(
  [string]$TaskName = 'Excubitor-Ergo-Watch',
  [ValidateRange(5, 1440)]
  [int]$IntervalMinutes = 15
)

# Registers the Ergo package update delivery job in Task Scheduler (registration only; nothing is started).
# spec/feature/ergo-watch-delivery.md

$ErrorActionPreference = 'Stop'
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $Utf8NoBom
[Console]::OutputEncoding = $Utf8NoBom
$OutputEncoding = $Utf8NoBom
$PSDefaultParameterValues['*:Encoding'] = 'utf8'

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$runnerPath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'run-ergo-watch.ps1')).Path
$cliPath = Join-Path $repoRoot 'dist\update\ergo-watch\cli.js'
if (-not (Test-Path -LiteralPath $cliPath -PathType Leaf)) {
  throw "Ergo watch CLI is not built: $cliPath. Run npm run build first."
}

$powerShellPath = (Get-Command powershell.exe -ErrorAction Stop).Source
$actionArguments = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runnerPath`""
$action = New-ScheduledTaskAction `
  -Execute $powerShellPath `
  -Argument $actionArguments `
  -WorkingDirectory $repoRoot
$trigger = New-ScheduledTaskTrigger `
  -Once `
  -At (Get-Date).Date `
  -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)
$principal = New-ScheduledTaskPrincipal `
  -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
  -LogonType Interactive `
  -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Description 'Excubitor: run ergo_pkg watch for catalog checkouts with ergo_watch and deliver new events (via Concordia or a Discord webhook).' `
  -Force

Write-Output "Registered $TaskName every $IntervalMinutes minutes. The task is not started by this installer."
