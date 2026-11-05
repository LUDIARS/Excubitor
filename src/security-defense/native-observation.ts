import { execFile } from 'node:child_process';
import { fingerprint, type Fingerprint } from './baseline.js';
import { WINDOWS_INVENTORY_COMMAND } from './windows-inventory.js';

export interface AuthSignal { at: number; kind: 'ssh_failure' | 'ssh_success'; actor: string }
export interface NativeObservation {
  state: 'healthy' | 'unsupported' | 'failed';
  inventoryState: 'healthy' | 'unsupported' | 'failed';
  auth: AuthSignal[]; entries: Fingerprint[];
}

/** Fixed local read-only commands, no shell or input-derived program text. Raw output never logged. */
function command(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {};
    for (const name of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'PSModulePath']) {
      if (process.env[name]) env[name] = process.env[name];
    }
    env.LC_ALL = 'C.UTF-8';
    execFile(file, args, { cwd: process.cwd(), encoding: 'utf8', windowsHide: true,
      env, timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => error || stderr.trim()
      ? reject(new Error('host collector unavailable')) : resolve(stdout));
  });
}

export function parseSshMessage(message: string, at: number): AuthSignal | null {
  // Only actual sshd authentication messages qualify. Never treat HTTP 200 as login success.
  const match = /\b(Accepted|Failed) (?:publickey|password|keyboard-interactive(?:\/pam)?) for (?:invalid user )?(\S+) from ([0-9a-fA-F:.]+) port \d+/.exec(message);
  if (!match || !Number.isFinite(at)) return null;
  return { at, kind: match[1] === 'Accepted' ? 'ssh_success' : 'ssh_failure', actor: fingerprint(`${match[2]}:${match[3]}`) };
}

export async function nativeObservation(since: number, platform = process.platform): Promise<NativeObservation> {
  if (platform !== 'linux' && platform !== 'win32') return { state: 'unsupported', inventoryState: 'unsupported', auth: [], entries: [] };
  const auth: AuthSignal[] = [];
  const entries: Fingerprint[] = [];
  let inventoryState: NativeObservation['inventoryState'] = platform === 'linux' ? 'healthy' : 'failed';
  try {
    if (platform === 'linux') {
      const text = await command('journalctl', ['--no-pager', '--quiet', '--output=json', '--identifier=sshd', '--since', `@${Math.floor(since / 1000)}`]);
      for (const line of text.split('\n').filter(Boolean)) {
        const row = JSON.parse(line) as { MESSAGE?: string; __REALTIME_TIMESTAMP?: string };
        if (typeof row.MESSAGE !== 'string') continue;
        const signal = parseSshMessage(row.MESSAGE, Number(row.__REALTIME_TIMESTAMP) / 1000);
        if (signal && signal.at > since) auth.push(signal);
      }
    } else {
      // Hash registry/startup/account metadata in-process. No executable action/arguments persisted.
      const inventory = await command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        WINDOWS_INVENTORY_COMMAND]);
      const parsed = JSON.parse(inventory) as Record<string, unknown>;
      for (const key of ['users', 'tasks', 'autorun']) entries.push({ asset: `windows_${key}`, hash: fingerprint(JSON.stringify(parsed[key])) });
      inventoryState = 'healthy';
      const events = await command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); $l=Get-WinEvent -ListLog 'OpenSSH/Operational'; if (-not $l.IsEnabled) { throw 'disabled' }; try { $e=@(Get-WinEvent -FilterHashtable @{LogName='OpenSSH/Operational';StartTime=(Get-Date).AddMinutes(-15)} -MaxEvents 5001 | Select-Object @{Name='at';Expression={$_.TimeCreated.ToUniversalTime().ToString('o')}},Message) } catch { if($_.FullyQualifiedErrorId -notlike 'NoMatchingEventsFound*') { throw }; $e=@() }; if($e.Count -gt 5000) { throw 'capacity' }; ConvertTo-Json -InputObject $e -Compress"]);
      for (const row of JSON.parse(events) as { at: string; Message: string }[]) {
        const at = Date.parse(row.at);
        const signal = parseSshMessage(row.Message, at);
        if (signal && signal.at > since) auth.push(signal);
      }
    }
    return { state: 'healthy', inventoryState, auth: auth.sort((a, b) => a.at - b.at), entries };
  } catch {
    // Explicit loss of coverage; do not claim absence of SSH attacks on a failed collector.
    return { state: 'failed', inventoryState, auth: [], entries };
  }
}
