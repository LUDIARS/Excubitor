$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $Here 'windows-service-safety.ps1')

Describe 'Windows service migration single-owner decisions' {
  It 'disables an enabled stopped task when the restored legacy service is runnable' {
    Get-ScheduledTaskRecoveryAction `
      -RestoreLegacyService $true `
      -LegacyRunnable $true `
      -TaskWasRunning $false | Should Be 'Disable'
  }

  It 'does not permit legacy restore beside an enabled task' {
    Test-LegacyRestoreHasSingleOwner `
      -LegacyRunnable $true `
      -TaskExists $true `
      -TaskDisabled $false | Should Be $false
  }

  It 'permits legacy restore after the task is disabled' {
    Test-LegacyRestoreHasSingleOwner `
      -LegacyRunnable $true `
      -TaskExists $true `
      -TaskDisabled $true | Should Be $true
  }

  It 'restarts the task only when no runnable legacy owner was restored' {
    Get-ScheduledTaskRecoveryAction `
      -RestoreLegacyService $true `
      -LegacyRunnable $false `
      -TaskWasRunning $true | Should Be 'Start'
  }

  It 'disables the restored legacy owner when task quiescing fails' {
    Get-LegacyOwnerFailSafeAction `
      -RestoreLegacyService $true `
      -LegacyRunnable $true `
      -TaskQuiesced $false | Should Be 'DisableLegacy'
  }
}
