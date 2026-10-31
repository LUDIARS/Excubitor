# @implements SPEC-EX-NETWATCH
# Install the Excubitor netwatch firewall sync task. Run once from an elevated PowerShell.
#
# - Copies netwatch-firewall-sync.ps1 to %ProgramData%\Excubitor\netwatch-firewall, which only SYSTEM and
#   Administrators can write (Users can read). The task never runs the copy inside the repository, because
#   the repository is writable by the Limited account and a SYSTEM task must not run user-writable code.
# - The status file is written into the same protected directory; Excubitor reads it from there.
# - Registers a scheduled task running as SYSTEM every minute (and at startup).
# Re-run after updating the repository to copy the new sync script. Nothing is started by this installer.

[CmdletBinding()]
param(
  [string]$TaskName = 'Excubitor-Netwatch-Firewall',
  # The desired-state file written by Excubitor (netwatch.block.file). Defaults to this checkout's data directory.
  [string]$BlocksFile = '',
  [ValidateRange(1, 60)]
  [int]$IntervalMinutes = 1
)

$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principalCheck = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principalCheck.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this script from an elevated (Administrator) PowerShell.'
}
if ($TaskName -notmatch '\A[A-Za-z0-9_.-]+\z') { throw "Invalid task name '$TaskName'." }
if (-not $env:ProgramData) { throw 'ProgramData is not set; cannot decide the install directory.' }

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if (-not $BlocksFile) { $BlocksFile = Join-Path $repoRoot 'data\netwatch\firewall-blocks.json' }
$BlocksFile = [IO.Path]::GetFullPath($BlocksFile)
$installDir = Join-Path $env:ProgramData 'Excubitor\netwatch-firewall'
$syncScript = Join-Path $installDir 'netwatch-firewall-sync.ps1'
$statusFile = Join-Path $installDir 'status.json'
foreach ($path in @($BlocksFile, $installDir)) {
  if ($path.Contains('"')) { throw "Path must not contain a double quote: $path" }
}

New-Item -ItemType Directory -Path $installDir -Force | Out-Null
# Protected directory: no inheritance; SYSTEM and Administrators full control, Users read only.
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
$inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
$propagate = [System.Security.AccessControl.PropagationFlags]::None
$allow = [System.Security.AccessControl.AccessControlType]::Allow
foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
  $account = New-Object System.Security.Principal.SecurityIdentifier($sid)
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($account, 'FullControl', $inherit, $propagate, $allow)))
}
$users = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-545')
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($users, 'ReadAndExecute', $inherit, $propagate, $allow)))
$acl.SetOwner((New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')))
Set-Acl -LiteralPath $installDir -AclObject $acl

Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'netwatch-firewall-sync.ps1') -Destination $syncScript -Force

$powerShellPath = (Get-Command powershell.exe -ErrorAction Stop).Source
$arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$syncScript`" -BlocksFile `"$BlocksFile`" -StatusFile `"$statusFile`""
$action = New-ScheduledTaskAction -Execute $powerShellPath -Argument $arguments -WorkingDirectory $installDir
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)
$startup = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($repeat, $startup) -Principal $principal `
  -Settings $settings -Description 'Excubitor netwatch: sync outbound block rules (group Excubitor-netwatch) from the blocks file.' `
  -Force | Out-Null

Write-Output "Registered $TaskName (SYSTEM, every $IntervalMinutes min)."
Write-Output "  sync script : $syncScript"
Write-Output "  blocks file : $BlocksFile"
Write-Output "  status file : $statusFile"
Write-Output 'The task is not started by this installer; it runs at the next interval.'
