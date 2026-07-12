function Get-ScheduledTaskRecoveryAction {
  param(
    [bool]$RestoreLegacyService,
    [bool]$LegacyRunnable,
    [bool]$TaskWasRunning
  )

  if ($RestoreLegacyService -and $LegacyRunnable) { return 'Disable' }
  if ($TaskWasRunning) { return 'Start' }
  return 'Leave'
}

function Test-LegacyRestoreHasSingleOwner {
  param(
    [bool]$LegacyRunnable,
    [bool]$TaskExists,
    [bool]$TaskDisabled
  )

  return -not $LegacyRunnable -or -not $TaskExists -or $TaskDisabled
}

function Get-LegacyOwnerFailSafeAction {
  param(
    [bool]$RestoreLegacyService,
    [bool]$LegacyRunnable,
    [bool]$TaskQuiesced
  )

  if ($RestoreLegacyService -and $LegacyRunnable -and -not $TaskQuiesced) {
    return 'DisableLegacy'
  }
  return 'Leave'
}
