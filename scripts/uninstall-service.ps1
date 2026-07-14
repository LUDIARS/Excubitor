[CmdletBinding()]
param(
  [string]$Name = "Excubitor",
  [switch]$RestoreLegacyService
)

$ErrorActionPreference = 'Stop'
if ($Name -notmatch '\A[A-Za-z0-9_.-]+\z') {
  throw "Invalid service name '$Name' (allowed: A-Z a-z 0-9 _ . -)."
}
$Root = Split-Path -Parent $PSScriptRoot
$SafeName = $Name -replace '[^A-Za-z0-9_.-]', '_'
$MigrationRecordPath = Join-Path (Join-Path $Root 'data') "windows-service-migration-$SafeName.json"
$TaskPath = '\'
$RunScript = [IO.Path]::GetFullPath((Join-Path $Root 'scripts\run-service.ps1'))
$ServiceRunner = [IO.Path]::GetFullPath((Join-Path $Root 'dist\service-runner.js'))
. (Join-Path $PSScriptRoot 'windows-service-safety.ps1')

function Test-IsAdministrator {
  $Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $Principal = [Security.Principal.WindowsPrincipal]::new($Identity)
  return $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
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

function Get-LegacyServiceInfo([string]$ServiceName) {
  $EscapedName = $ServiceName.Replace("'", "''")
  return Get-CimInstance -ClassName Win32_Service -Filter "Name='$EscapedName'" -ErrorAction SilentlyContinue
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
    throw "Legacy Windows Service '$ServiceName' could not be held stopped/disabled after task recovery failure."
  }
}

function Wait-ScheduledTaskStopped([string]$TaskName, [int]$TimeoutSeconds = 20) {
  $Deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $Task = Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue
    if (-not $Task -or $Task.State -ne 'Running') { return $true }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $Deadline)
  return $false
}

function Disable-ScheduledTaskOwner([string]$TaskName) {
  $Task = Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue
  if (-not $Task) { return }
  if ($Task.State -eq 'Running') {
    Stop-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath
    if (-not (Wait-ScheduledTaskStopped $TaskName)) {
      throw "Scheduled Task '$TaskName' did not stop during single-owner recovery."
    }
  }
  Disable-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath | Out-Null
  $DisabledTask = Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue
  if ($DisabledTask -and $DisabledTask.State -ne 'Disabled') {
    throw "Scheduled Task '$TaskName' could not be verified disabled during single-owner recovery."
  }
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
    throw "Scheduled Task '$TaskPath$Name' is not owned by this Excubitor checkout and was not removed."
  }
}

$MigrationRecord = $null
if ($RestoreLegacyService) {
  if (-not (Test-Path -LiteralPath $MigrationRecordPath)) {
    throw "Cannot restore legacy service: migration record '$MigrationRecordPath' does not exist. No task was changed."
  }
  $MigrationRecord = Get-Content -LiteralPath $MigrationRecordPath -Raw | ConvertFrom-Json
  if ([string]$MigrationRecord.name -ne $Name) {
    throw "Migration record belongs to service '$($MigrationRecord.name)', not '$Name'. No task was changed."
  }
  if (-not (Test-IsAdministrator)) {
    throw "Restoring legacy Windows Service '$Name' requires an elevated PowerShell. No task was changed."
  }
  if (-not (Get-Service -Name $Name -ErrorAction SilentlyContinue)) {
    throw "Legacy Windows Service '$Name' no longer exists. No task was changed."
  }
}

$TaskWasRunning = $ExistingTask -and $ExistingTask.State -eq 'Running'
try {
  if ($ExistingTask -and $ExistingTask.State -eq 'Running') {
    Stop-ScheduledTask -TaskName $Name -TaskPath $TaskPath
    if (-not (Wait-ScheduledTaskStopped $Name)) {
      throw "Scheduled Task '$Name' did not stop; the legacy service was not restored."
    }
  }

  if ($RestoreLegacyService) {
    Restore-LegacyService $MigrationRecord
  }

  if ($ExistingTask) {
    Unregister-ScheduledTask -TaskName $Name -TaskPath $TaskPath -Confirm:$false
  }
} catch {
  $UninstallError = $_.Exception.Message
  $RecoveryErrors = [Collections.Generic.List[string]]::new()
  $RemainingTask = Get-ScheduledTask -TaskName $Name -TaskPath $TaskPath -ErrorAction SilentlyContinue
  if ($RemainingTask) {
    try {
      # Treat an unreadable legacy state pessimistically during restore. The
      # fail-safe must prefer disabling it over risking a second owner.
      $LegacyRunnable = [bool]$RestoreLegacyService
      if ($RestoreLegacyService) {
        $LegacyState = Get-LegacyServiceInfo $Name
        if ($LegacyState) {
          $LegacyRunnable = $LegacyState.State -eq 'Running' -or $LegacyState.StartMode -ne 'Disabled'
        }
      }
      $RecoveryAction = Get-ScheduledTaskRecoveryAction `
        -RestoreLegacyService ([bool]$RestoreLegacyService) `
        -LegacyRunnable ([bool]$LegacyRunnable) `
        -TaskWasRunning ([bool]$TaskWasRunning)
      switch ($RecoveryAction) {
        'Disable' {
          # A restored/runnable legacy owner and an enabled logon task must
          # never coexist, even when the task was already stopped.
          Disable-ScheduledTaskOwner $Name
        }
        'Start' {
          Start-ScheduledTask -TaskName $Name -TaskPath $TaskPath
        }
      }
    } catch {
      $TaskRecoveryError = $_.Exception.Message
      $RecoveryErrors.Add("task recovery failed: $TaskRecoveryError")
      $LegacyFailSafeAction = Get-LegacyOwnerFailSafeAction `
        -RestoreLegacyService ([bool]$RestoreLegacyService) `
        -LegacyRunnable ([bool]$LegacyRunnable) `
        -TaskQuiesced $false
      if ($LegacyFailSafeAction -eq 'DisableLegacy') {
        try {
          Disable-LegacyServiceOwner $Name
          $RecoveryErrors.Add('legacy service was returned to stopped/disabled because task quiescing failed')
        } catch {
          $RecoveryErrors.Add("legacy service fail-safe disable failed: $($_.Exception.Message)")
        }
      }
    }
  }
  $RecoveryDetail = if ($RecoveryErrors.Count -gt 0) {
    " Recovery also reported: $($RecoveryErrors -join '; ')"
  } else {
    ' Task recovery completed or was not required.'
  }
  throw "Failed to uninstall Scheduled Task '$Name': ${UninstallError}.${RecoveryDetail} A runnable legacy service and enabled task were not intentionally left together."
}

if ($RestoreLegacyService) {
  Remove-Item -LiteralPath $MigrationRecordPath -Force
  Write-Host "Removed per-user task '$Name' and restored the preserved legacy Windows Service configuration."
} else {
  Write-Host "Removed per-user task '$Name' if it existed. No Windows Service registration was removed or changed."
  if (Test-Path -LiteralPath $MigrationRecordPath) {
    Write-Warning "Legacy service '$Name' remains stopped/disabled. Reinstall the task, or run this script with -RestoreLegacyService from an elevated PowerShell to restore it."
  }
}
