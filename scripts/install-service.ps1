[CmdletBinding()]
param(
  [string]$Name = "Excubitor",
  [switch]$MigrateLegacyService
)

$ErrorActionPreference = 'Stop'
if ($Name -notmatch '\A[A-Za-z0-9_.-]+\z') {
  throw "Invalid service name '$Name' (allowed: A-Z a-z 0-9 _ . -)."
}
$Root = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $Root 'logs'
$DataDir = Join-Path $Root 'data'
$SafeName = $Name -replace '[^A-Za-z0-9_.-]', '_'
$MigrationRecordPath = Join-Path $DataDir "windows-service-migration-$SafeName.json"
$TaskPath = '\'
$RunScript = [IO.Path]::GetFullPath((Join-Path $Root 'scripts\run-service.ps1'))
$ServiceRunner = [IO.Path]::GetFullPath((Join-Path $Root 'dist\service-runner.js'))
$NodeCommand = Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1
$NodeExecutable = [IO.Path]::GetFullPath($NodeCommand.Source)
. (Join-Path $PSScriptRoot 'windows-service-safety.ps1')

function Test-IsAdministrator {
  $Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $Principal = [Security.Principal.WindowsPrincipal]::new($Identity)
  return $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-LegacyServiceInfo([string]$ServiceName) {
  $EscapedName = $ServiceName.Replace("'", "''")
  return Get-CimInstance -ClassName Win32_Service -Filter "Name='$EscapedName'" -ErrorAction SilentlyContinue
}

function Restore-LegacyService($Backup) {
  $StartupType = switch ([string]$Backup.start_mode) {
    'Auto' { 'Automatic' }
    'Manual' { 'Manual' }
    'Disabled' { 'Disabled' }
    default { throw "Unsupported saved Windows Service start mode '$($Backup.start_mode)'." }
  }

  Set-Service -Name ([string]$Backup.name) -StartupType $StartupType
  if ($Backup.start_mode -eq 'Auto' -and [bool]$Backup.delayed_auto_start) {
    & sc.exe config ([string]$Backup.name) start= delayed-auto | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "Failed to restore delayed-auto start for Windows Service '$($Backup.name)'."
    }
  }
  if ([bool]$Backup.was_running) {
    Start-Service -Name ([string]$Backup.name)
    (Get-Service -Name ([string]$Backup.name)).WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
  }
}

function Wait-ScheduledTaskState([string]$TaskName, [scriptblock]$Predicate, [int]$TimeoutSeconds = 20) {
  $Deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $Task = Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue
    if ($Task -and (& $Predicate $Task)) { return $Task }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $Deadline)
  return $null
}

function Disable-ScheduledTaskOwner([string]$TaskName) {
  $Task = Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue
  if (-not $Task) { return }
  if ($Task.State -eq 'Running') {
    Stop-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath
    if (-not (Wait-ScheduledTaskState $TaskName { param($Current) $Current.State -ne 'Running' })) {
      throw "Scheduled Task '$TaskName' did not stop during single-owner recovery."
    }
  }
  Disable-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath | Out-Null
  $DisabledTask = Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue
  if ($DisabledTask -and $DisabledTask.State -ne 'Disabled') {
    throw "Scheduled Task '$TaskName' could not be verified disabled during single-owner recovery."
  }
}

function Disable-LegacyServiceOwner([string]$ServiceName) {
  $Service = Get-LegacyServiceInfo $ServiceName
  if (-not $Service) { return }
  if ($Service.State -ne 'Stopped') {
    Stop-Service -Name $ServiceName
    (Get-Service -Name $ServiceName).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
  }
  Set-Service -Name $ServiceName -StartupType Disabled
  $DisabledService = Get-LegacyServiceInfo $ServiceName
  if (-not $DisabledService -or $DisabledService.State -ne 'Stopped' -or $DisabledService.StartMode -ne 'Disabled') {
    throw "Legacy Windows Service '$ServiceName' could not be held stopped/disabled after rollback failure."
  }
}

$LegacyService = Get-LegacyServiceInfo $Name
$ExistingRecord = $null
if (Test-Path -LiteralPath $MigrationRecordPath) {
  try {
    $ExistingRecord = Get-Content -LiteralPath $MigrationRecordPath -Raw | ConvertFrom-Json
  } catch {
    throw "Cannot read migration record '$MigrationRecordPath': $($_.Exception.Message)"
  }
  if ([string]$ExistingRecord.name -ne $Name) {
    throw "Migration record '$MigrationRecordPath' belongs to service '$($ExistingRecord.name)', not '$Name'."
  }
}

$AlreadyMigrated = $LegacyService `
  -and $ExistingRecord `
  -and $LegacyService.StartMode -eq 'Disabled' `
  -and $LegacyService.State -eq 'Stopped'

if ($LegacyService -and -not $AlreadyMigrated -and -not $MigrateLegacyService) {
  throw @"
Legacy Windows Service/NSSM service '$Name' was detected (state=$($LegacyService.State), start_mode=$($LegacyService.StartMode)).
No service or scheduled task was changed. Running it beside the per-user Scheduled Task can create two local-control owners.

To migrate explicitly, re-run this script from an elevated PowerShell with:
  powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1 -Name "$Name" -MigrateLegacyService

Migration stops and disables the legacy service but does not delete it. Its previous state is recorded for rollback.
"@
}

if ($LegacyService -and -not $AlreadyMigrated -and -not (Test-IsAdministrator)) {
  throw "Migrating legacy Windows Service '$Name' requires an elevated PowerShell. No service or scheduled task was changed."
}

$ExistingTask = Get-ScheduledTask -TaskName $Name -TaskPath $TaskPath -ErrorAction SilentlyContinue
if ($ExistingTask) {
  $OwnedTask = @($ExistingTask.Actions) | Where-Object {
    $Arguments = [string]$_.Arguments
    $Arguments -and (
      $Arguments.IndexOf($ServiceRunner, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
      $Arguments.IndexOf($RunScript, [StringComparison]::OrdinalIgnoreCase) -ge 0
    )
  }
  if (-not $OwnedTask) {
    throw "Scheduled Task '$TaskPath$Name' already exists but is not owned by this Excubitor checkout. It was not replaced."
  }
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

# Keep the legacy owner running while dependencies and artifacts are prepared.
# The downtime/migration transaction begins only after all builds succeed.
Push-Location $Root
try {
  npm install
  npm run build
  npm --prefix frontend install
  npm --prefix frontend run build
} finally {
  Pop-Location
}

$CurrentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$ActionArguments = "`"$ServiceRunner`" --service-name=$Name"
$Action = New-ScheduledTaskAction -Execute $NodeExecutable -Argument $ActionArguments -WorkingDirectory $Root
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $CurrentUser
$Principal = New-ScheduledTaskPrincipal -UserId $CurrentUser -LogonType Interactive -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew

$PreviousTaskXml = if ($ExistingTask) {
  Export-ScheduledTask -TaskName $Name -TaskPath $TaskPath
} else {
  $null
}
$PreviousTaskWasRunning = $ExistingTask -and $ExistingTask.State -eq 'Running'
$LegacyBackup = $ExistingRecord
$CreatedMigrationRecord = $false
$LegacyTouched = $false
$TaskTouched = $false

try {
  if ($LegacyService -and -not $AlreadyMigrated) {
    if (-not $LegacyBackup) {
      $LegacyBackup = [ordered]@{
        version = 1
        name = $Name
        display_name = [string]$LegacyService.DisplayName
        path_name = [string]$LegacyService.PathName
        start_mode = [string]$LegacyService.StartMode
        delayed_auto_start = [bool]$LegacyService.DelayedAutoStart
        was_running = $LegacyService.State -eq 'Running'
        captured_at = (Get-Date).ToUniversalTime().ToString('o')
      }
      $TemporaryRecord = "$MigrationRecordPath.tmp-$PID"
      $LegacyBackup | ConvertTo-Json | Set-Content -LiteralPath $TemporaryRecord -Encoding UTF8
      Move-Item -LiteralPath $TemporaryRecord -Destination $MigrationRecordPath -Force
      $CreatedMigrationRecord = $true
    }

    $LegacyTouched = $true
    if ($LegacyService.State -ne 'Stopped') {
      Stop-Service -Name $Name
      (Get-Service -Name $Name).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
    }
    Set-Service -Name $Name -StartupType Disabled
    $DisabledService = Get-LegacyServiceInfo $Name
    if (-not $DisabledService -or $DisabledService.State -ne 'Stopped' -or $DisabledService.StartMode -ne 'Disabled') {
      throw "Legacy Windows Service '$Name' did not reach stopped/disabled state."
    }
    Write-Host "Legacy Windows Service '$Name' is stopped and disabled; registration was preserved."
  }

  $TaskTouched = $true
  if ($ExistingTask -and $ExistingTask.State -eq 'Running') {
    Stop-ScheduledTask -TaskName $Name -TaskPath $TaskPath
    if (-not (Wait-ScheduledTaskState $Name { param($Task) $Task.State -ne 'Running' })) {
      throw "Existing Scheduled Task '$Name' did not stop."
    }
  }

  Register-ScheduledTask -TaskName $Name -TaskPath $TaskPath -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal -Force | Out-Null
  Start-ScheduledTask -TaskName $Name -TaskPath $TaskPath
  $RunningTask = Wait-ScheduledTaskState $Name { param($Task) $Task.State -eq 'Running' }
  Start-Sleep -Seconds 1
  $StableTask = Get-ScheduledTask -TaskName $Name -TaskPath $TaskPath -ErrorAction SilentlyContinue
  if (-not $RunningTask -or -not $StableTask -or $StableTask.State -ne 'Running') {
    throw "Scheduled Task '$Name' did not remain running after activation."
  }
} catch {
  $InstallError = $_.Exception.Message
  $RollbackErrors = [Collections.Generic.List[string]]::new()
  $LegacyWillOwnRollback = $LegacyTouched -and $LegacyBackup -and (
    [bool]$LegacyBackup.was_running -or [string]$LegacyBackup.start_mode -eq 'Auto'
  )
  $TaskRollbackFailed = $false
  $TaskSafeForLegacyRestore = -not $LegacyTouched

  if ($TaskTouched) {
    try {
      $CurrentTask = Get-ScheduledTask -TaskName $Name -TaskPath $TaskPath -ErrorAction SilentlyContinue
      if ($CurrentTask -and $CurrentTask.State -eq 'Running') {
        Stop-ScheduledTask -TaskName $Name -TaskPath $TaskPath
        if (-not (Wait-ScheduledTaskState $Name { param($Task) $Task.State -ne 'Running' })) {
          throw "Scheduled Task '$Name' did not stop during rollback."
        }
      }
      if ($PreviousTaskXml) {
        Register-ScheduledTask -TaskName $Name -TaskPath $TaskPath -Xml $PreviousTaskXml -Force | Out-Null
        if ($LegacyWillOwnRollback) {
          # Do not recreate the duplicate-owner condition on the next logon.
          Disable-ScheduledTaskOwner $Name
        } elseif ($PreviousTaskWasRunning) {
          Start-ScheduledTask -TaskName $Name -TaskPath $TaskPath
        }
      } elseif ($CurrentTask) {
        Unregister-ScheduledTask -TaskName $Name -TaskPath $TaskPath -Confirm:$false
        if (Get-ScheduledTask -TaskName $Name -TaskPath $TaskPath -ErrorAction SilentlyContinue) {
          throw "Scheduled Task '$Name' still exists after rollback unregister."
        }
      }
    } catch {
      $TaskRollbackFailed = $true
      $RollbackErrors.Add("scheduled task rollback: $($_.Exception.Message)")
    }
  } elseif ($LegacyWillOwnRollback) {
    # Migration can fail before the task transaction starts. Quiesce any
    # pre-existing task before restoring a runnable legacy owner.
    try {
      Disable-ScheduledTaskOwner $Name
    } catch {
      $TaskRollbackFailed = $true
      $RollbackErrors.Add("scheduled task quiesce: $($_.Exception.Message)")
    }
  }

  if ($LegacyTouched) {
    try {
      if ($TaskRollbackFailed) {
        Disable-ScheduledTaskOwner $Name
      }
      $RemainingTask = Get-ScheduledTask -TaskName $Name -TaskPath $TaskPath -ErrorAction SilentlyContinue
      $TaskDisabled = -not $RemainingTask -or $RemainingTask.State -eq 'Disabled'
      $RequiresQuiescedTask = $TaskRollbackFailed -or $LegacyWillOwnRollback
      if (-not (Test-LegacyRestoreHasSingleOwner `
        -LegacyRunnable $RequiresQuiescedTask `
        -TaskExists ([bool]$RemainingTask) `
        -TaskDisabled $TaskDisabled)) {
        throw "Scheduled Task '$Name' is still enabled; legacy service restore is unsafe."
      }
      $TaskSafeForLegacyRestore = $true
    } catch {
      $TaskSafeForLegacyRestore = $false
      $RollbackErrors.Add("single-owner verification: $($_.Exception.Message)")
    }
  }

  if ($LegacyTouched -and $LegacyBackup) {
    if ($TaskSafeForLegacyRestore) {
      try {
        Restore-LegacyService $LegacyBackup
        if ($CreatedMigrationRecord -and (Test-Path -LiteralPath $MigrationRecordPath)) {
          Remove-Item -LiteralPath $MigrationRecordPath -Force
        }
      } catch {
        $RollbackErrors.Add("legacy service rollback: $($_.Exception.Message)")
        try {
          Disable-LegacyServiceOwner $Name
        } catch {
          $RollbackErrors.Add("legacy service fail-safe disable: $($_.Exception.Message)")
        }
      }
    } else {
      $RollbackErrors.Add('legacy service restore skipped because the scheduled task could not be proven quiesced')
      try {
        Disable-LegacyServiceOwner $Name
      } catch {
        $RollbackErrors.Add("legacy service fail-safe disable: $($_.Exception.Message)")
      }
    }
  }

  $RollbackDetail = if ($RollbackErrors.Count -gt 0) {
    " Rollback also reported: $($RollbackErrors -join '; ')"
  } else {
    ' A single-owner rollback completed.'
  }
  throw "Failed to install per-user Scheduled Task '$Name': ${InstallError}.${RollbackDetail}"
}

Write-Host "Installed hidden per-user logon task '$Name' for '$CurrentUser'."
if ($LegacyService) {
  Write-Host "Legacy service registration was retained. Migration record: $MigrationRecordPath"
  Write-Host "To remove the task and explicitly restore the legacy service, run scripts\uninstall-service.ps1 -Name `"$Name`" -RestoreLegacyService from an elevated PowerShell."
}
