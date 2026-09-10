import type { Service } from '../catalog/loader.js';
import type { ControlAction, ControlResult } from '../control/docker-compose.js';
import type { ServiceStatusPayload } from '../local-control/protocol.js';
import { androidTarget, repositoryApk, type AdbResult } from './adb.js';

function requireSuccess(result: AdbResult): void {
  if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `ADB exited ${result.code}`);
}

export async function androidStatus(service: Service): Promise<ServiceStatusPayload> {
  const target = await androidTarget(service);
  const result = await target.run(['shell', 'pidof', target.config.package]);
  // pidof returns 1 when no matching process exists. Other failures are unknown.
  if (result.code !== 0 && !(result.code === 1 && !result.stderr.trim() && !result.stdout.trim())) requireSuccess(result);
  const pids = result.stdout.trim();
  if (pids && !/^\d+(\s+\d+)*$/.test(pids)) throw new Error('Unexpected Android process status');
  return { kind: 'service-status', code: service.code, runtime: service.runtime,
    state: pids ? 'running' : 'stopped', running: Boolean(pids), pid: null };
}

/** Called by the supervisor through the existing per-service operation queue. */
export async function controlAndroid(service: Service, action: ControlAction): Promise<ControlResult> {
  const command = `android ${action} ${service.code}`;
  try {
    const target = await androidTarget(service);
    // Validate the input before stopping an existing app on restart.
    const apk = action === 'stop' ? null : await repositoryApk(target.cwd, target.config.apk);
    if (action === 'stop' || action === 'restart') {
      requireSuccess(await target.run(['shell', 'am', 'force-stop', target.config.package]));
    }
    if (apk) {
      const installed = await target.run(['install', '-r', apk]);
      requireSuccess(installed);
      if (!/^Success\s*$/m.test(installed.stdout)) throw new Error('ADB did not confirm APK installation');
      const launched = await target.run(['shell', 'am', 'start', '-W', '-n', `${target.config.package}/${target.config.activity}`]);
      requireSuccess(launched);
      if (!/^Status:\s*ok\s*$/m.test(launched.stdout) || /(^|\n)Error:/m.test(launched.stdout + launched.stderr)) {
        throw new Error('Android activity launch was not confirmed');
      }
    }
    const status = await androidStatus(service);
    if (status.running !== (action !== 'stop')) throw new Error('Android process state did not match the requested action');
    return { ok: true, stdout: status.state, stderr: '', exit_code: 0, command };
  } catch (error) {
    return { ok: false, stdout: '', stderr: error instanceof Error ? error.message : String(error), exit_code: -1, command };
  }
}
