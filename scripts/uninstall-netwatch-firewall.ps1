# @implements SPEC-EX-NETWATCH
# Uninstall the Excubitor netwatch firewall sync task. Run from an elevated PowerShell.
# Removes the scheduled task and every rule in the group "Excubitor-netwatch" (named ExcubitorNetwatch-*),
# so all blocks made through Excubitor stop. Rules outside that group are never touched.
# The protected directory under %ProgramData% is removed only with -RemoveFiles.

[CmdletBinding()]
param(
  [string]$TaskName = 'Excubitor-Netwatch-Firewall',
  [switch]$RemoveFiles
)

$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principalCheck = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principalCheck.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this script from an elevated (Administrator) PowerShell.'
}
if ($TaskName -notmatch '\A[A-Za-z0-9_.-]+\z') { throw "Invalid task name '$TaskName'." }

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Output "Unregistered $TaskName."
}

$removed = 0
foreach ($rule in @(Get-NetFirewallRule -Group 'Excubitor-netwatch' -ErrorAction SilentlyContinue)) {
  if (-not $rule.Name.StartsWith('ExcubitorNetwatch-')) { continue }
  Remove-NetFirewallRule -Name $rule.Name
  $removed += 1
}
Write-Output "Removed $removed rule(s) in group Excubitor-netwatch."

if ($RemoveFiles -and $env:ProgramData) {
  $installDir = Join-Path $env:ProgramData 'Excubitor\netwatch-firewall'
  if (Test-Path -LiteralPath $installDir) {
    Remove-Item -LiteralPath $installDir -Recurse -Force
    Write-Output "Removed $installDir."
  }
}
