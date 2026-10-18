import type { SupervisorRestartPlan } from './supervisor-service-restart.js';

/** How long the old supervisor may take to exit after Stop-ScheduledTask before it is killed. */
const STOP_GRACE_MS = 5_000;

/** @implements SPEC-EX-UNIFIED-UPDATE */
export function windowsSupervisorRestartScript(name: string, supervisorPid: number, timeoutMs = 45_000): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) throw new Error('Unsupported OS service name');
  if (!Number.isSafeInteger(supervisorPid) || supervisorPid <= 0) throw new Error('Invalid supervisor PID');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 45_000) throw new Error('Invalid supervisor stop timeout');
  return `
$ErrorActionPreference = 'Stop'
$taskName = '${name}'
$oldSupervisor = Get-Process -Id ${supervisorPid} -ErrorAction Stop
try {
  # Acquire the process handle before stopping: a reused PID must not satisfy the wait.
  $null = $oldSupervisor.Handle
  $task = Get-ScheduledTask -TaskName $taskName -TaskPath '\\' -ErrorAction Stop
  if ($task.State -ne 'Running') { throw 'Expected a running Excubitor scheduled task' }
  $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  Stop-ScheduledTask -TaskName $taskName -TaskPath '\\' -ErrorAction Stop
  # The Task action is the hidden launcher; stopping the Task ends only the launcher and
  # leaves its node child running. After a short grace, end the old supervisor through the
  # handle taken above (never by PID or name), as Stop did when the Task ran node directly.
  $remaining = ${timeoutMs} - [int]$stopwatch.ElapsedMilliseconds
  if ($remaining -gt 0 -and -not $oldSupervisor.WaitForExit([Math]::Min(${STOP_GRACE_MS}, $remaining))) {
    # Kill throws if the process exited in between; the wait below decides the outcome.
    try { $oldSupervisor.Kill() } catch { }
  }
  $remaining = ${timeoutMs} - [int]$stopwatch.ElapsedMilliseconds
  if ($remaining -le 0 -or -not $oldSupervisor.WaitForExit($remaining)) {
    throw 'Old Excubitor supervisor did not exit; replacement was not started'
  }
  # /End completion alone does not mean Task Scheduler has released its instance.
  while ($true) {
    $remaining = ${timeoutMs} - [int]$stopwatch.ElapsedMilliseconds
    if ($remaining -le 0) { throw 'Excubitor scheduled task did not stop; replacement was not started' }
    $task = Get-ScheduledTask -TaskName $taskName -TaskPath '\\' -ErrorAction Stop
    if ($task.State -eq 'Ready') { break }
    if ($task.State -ne 'Running') { throw 'Excubitor scheduled task is not ready for restart' }
    Start-Sleep -Milliseconds ([Math]::Min(200, $remaining))
  }
  Start-ScheduledTask -TaskName $taskName -TaskPath '\\' -ErrorAction Stop
} finally {
  $oldSupervisor.Dispose()
}
`;
}

export function planWindowsSupervisorRestart(name: string, supervisorPid: number): SupervisorRestartPlan {
  // Use one hidden OS-manager command so no caller can run the replacement before both waits.
  const script = windowsSupervisorRestartScript(name, supervisorPid);
  return { commands: [{
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
  }] };
}
