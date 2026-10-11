# Rewrites only the action of an installed Excubitor scheduled task so that it starts through
# the windowless launcher. Design: spec/plan/design.md section 17.7.
#
# Re-running install-service.ps1 recreates the task and drops Node arguments added by hand
# (for example --env-file=...). This script keeps the existing executable, arguments and
# working directory, and only puts the launcher in front. If the task already uses the
# launcher, it just switches to the current launcher build (idempotent).
# The running supervisor is not touched; the change applies from the next supervisor start
# (npm run ctl -- excubitor restart --json).
[CmdletBinding()]
param(
  [string]$Name = "Excubitor"
)

$ErrorActionPreference = 'Stop'
if ($Name -notmatch '\A[A-Za-z0-9_.-]+\z') {
  throw "Invalid service name '$Name' (allowed: A-Z a-z 0-9 _ . -)."
}
$Root = Split-Path -Parent $PSScriptRoot
$DataDir = Join-Path $Root 'data'
$TaskPath = '\'
$ServiceRunner = [IO.Path]::GetFullPath((Join-Path $Root 'dist\service-runner.js'))
. (Join-Path $PSScriptRoot 'windows-hidden-launcher.ps1')

$Task = Get-ScheduledTask -TaskName $Name -TaskPath $TaskPath -ErrorAction Stop
$Actions = @($Task.Actions)
if ($Actions.Count -ne 1) {
  throw "Scheduled Task '$TaskPath$Name' has $($Actions.Count) actions; expected exactly one. Nothing was changed."
}
$Current = $Actions[0]
$Arguments = [string]$Current.Arguments
if ($Arguments.IndexOf($ServiceRunner, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
  throw "Scheduled Task '$TaskPath$Name' is not owned by this Excubitor checkout. Nothing was changed."
}

if (Test-ExcubitorHiddenLauncherPath $Current.Execute) {
  # Already behind the launcher: the arguments are "<node.exe>" <node arguments>; keep them.
  $ActionArguments = $Arguments
} else {
  $ActionArguments = "`"$($Current.Execute)`" $Arguments"
}

$HiddenLauncher = Install-ExcubitorHiddenLauncher $DataDir
$WorkingDirectory = if ([string]::IsNullOrEmpty($Current.WorkingDirectory)) { $Root } else { $Current.WorkingDirectory }
$Action = New-ScheduledTaskAction -Execute $HiddenLauncher -Argument $ActionArguments -WorkingDirectory $WorkingDirectory
Set-ScheduledTask -TaskName $Name -TaskPath $TaskPath -Action $Action | Out-Null

$Updated = @((Get-ScheduledTask -TaskName $Name -TaskPath $TaskPath -ErrorAction Stop).Actions)[0]
Write-Output "Scheduled Task '$TaskPath$Name' now starts: $($Updated.Execute) $($Updated.Arguments)"
Write-Output "Takes effect on the next supervisor start: npm run ctl -- excubitor restart --json"
