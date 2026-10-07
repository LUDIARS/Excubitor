import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { planWindowsSupervisorRestart, windowsSupervisorRestartScript } from './windows-supervisor-restart.js';

const exec = promisify(execFile);
const POWERSHELL_TIMEOUT_MS = 15_000;
// Full-suite worker contention can make Windows PowerShell startup exceed Vitest's 5s default.
// Keep the test bound above execFile's limit so hung children are reaped before the test ends.
const POWERSHELL_TEST_TIMEOUT_MS = 20_000;

// Shadow all OS-control commands: these cases never touch a real process or task.
async function simulate(options: { exits?: boolean; neverReady?: boolean; stopFails?: boolean; startFails?: boolean } = {}) {
  const fixture = `
$global:events = [System.Collections.Generic.List[string]]::new()
$global:queries = 0
$global:exits = $${options.exits ?? true}
$global:neverReady = $${options.neverReady ?? false}
$global:stopFails = $${options.stopFails ?? false}
$global:startFails = $${options.startFails ?? false}
function Get-Process {
  $process = [pscustomobject]@{ Handle = 1 }
  $process | Add-Member ScriptMethod WaitForExit { param($milliseconds)
    $global:events.Add('wait-process')
    return $global:exits
  }
  $process | Add-Member ScriptMethod Dispose { $global:events.Add('dispose') }
  return $process
}
function Get-ScheduledTask {
  $global:queries++
  $state = if ($global:neverReady -or $global:queries -lt 3) { 'Running' } else { 'Ready' }
  $global:events.Add('task-' + $state)
  return [pscustomobject]@{ State = $state }
}
function Stop-ScheduledTask {
  $global:events.Add('stop')
  if ($global:stopFails) { throw 'stop refused' }
}
function Start-ScheduledTask {
  $global:events.Add('start')
  if ($global:startFails) { throw 'start refused' }
}
$failure = $null
try {
${windowsSupervisorRestartScript('Excubitor', 4242, options.neverReady ? 30 : 5_000)}
} catch { $failure = $_.Exception.Message }
[pscustomobject]@{ events = @($global:events.ToArray()); error = $failure } | ConvertTo-Json -Compress
`;
  const { stdout } = await exec('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(fixture, 'utf16le').toString('base64'),
  ], { windowsHide: true, timeout: POWERSHELL_TIMEOUT_MS, encoding: 'utf8' });
  return JSON.parse(stdout.trim()) as { events: string[]; error: string | null };
}

describe('Windows supervisor restart plan', () => {
  it('rejects invalid service names and process IDs before OS mutation', () => {
    expect(() => planWindowsSupervisorRestart("Excubitor'; Stop-Process", 4242)).toThrow('service name');
    expect(() => planWindowsSupervisorRestart('Excubitor', 0)).toThrow('PID');
  });
});

describe.skipIf(process.platform !== 'win32')('Windows supervisor replacement sequencing', () => {
  it('waits for both the original process and task instance before starting once', async () => {
    const result = await simulate();
    expect(result.error).toBeNull();
    expect(result.events).toEqual(['task-Running', 'stop', 'wait-process', 'task-Running', 'task-Ready', 'start', 'dispose']);
  }, POWERSHELL_TEST_TIMEOUT_MS);

  it('does not start a replacement while the old process survives', async () => {
    const result = await simulate({ exits: false });
    expect(result.error).toContain('did not exit');
    expect(result.events).toEqual(['task-Running', 'stop', 'wait-process', 'dispose']);
  }, POWERSHELL_TEST_TIMEOUT_MS);

  it('does not start if the task remains running after process exit', async () => {
    const result = await simulate({ neverReady: true });
    expect(result.error).toContain('did not stop');
    expect(result.events).toContain('wait-process');
    expect(result.events).not.toContain('start');
    expect(result.events.at(-1)).toBe('dispose');
  }, POWERSHELL_TEST_TIMEOUT_MS);

  it('releases the process handle and does not start when stopping fails', async () => {
    const result = await simulate({ stopFails: true });
    expect(result.error).toBe('stop refused');
    expect(result.events).toEqual(['task-Running', 'stop', 'dispose']);
  }, POWERSHELL_TEST_TIMEOUT_MS);

  it('reports start failure without retrying and releases the process handle', async () => {
    const result = await simulate({ startFails: true });
    expect(result.error).toBe('start refused');
    expect(result.events.filter(event => event === 'start')).toHaveLength(1);
    expect(result.events.at(-1)).toBe('dispose');
  }, POWERSHELL_TEST_TIMEOUT_MS);
});
