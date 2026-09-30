import { describe, expect, it } from 'vitest';
import { resolveLaunchdJob } from './launchd-job.js';
import { planLaunchdRestart } from './supervisor-service-restart.js';

const DAEMON_PLIST = '/Library/LaunchDaemons/com.ludiars.excubitor.plist';
const PRINT = 'system/com.ludiars.excubitor = {\n\tstate = running\n\tpid = 4242\n}';

function plist(extra: string): string {
  return `<plist><dict><key>Label</key><string>com.ludiars.excubitor</string>${extra}</dict></plist>`;
}

const daemonPlist = plist(
  '<key>UserName</key><string>neko</string><key>KeepAlive</key><true/><key>AbandonProcessGroup</key><true/>',
);

describe('resolveLaunchdJob', () => {
  it('prefers the boot-time LaunchDaemon in the system domain', () => {
    const job = resolveLaunchdJob('excubitor', { uid: 501, exists: (path) => path === DAEMON_PLIST });
    expect(job).toEqual({ kind: 'daemon', label: 'com.ludiars.excubitor', plistPath: DAEMON_PLIST, target: 'system/com.ludiars.excubitor' });
  });

  it('falls back to the per-user LaunchAgent', () => {
    const job = resolveLaunchdJob('excubitor', { uid: 501, homeDir: '/Users/neko', exists: () => false });
    expect(job.kind).toBe('agent');
    expect(job.target).toBe('gui/501/com.ludiars.excubitor');
    expect(job.plistPath).toBe('/Users/neko/Library/LaunchAgents/com.ludiars.excubitor.plist');
  });
});

describe('planLaunchdRestart', () => {
  const daemon = resolveLaunchdJob('excubitor', { uid: 501, exists: () => true });
  const agent = resolveLaunchdJob('excubitor', { uid: 501, exists: () => false });

  it('kickstarts a LaunchAgent through launchd', () => {
    const plan = planLaunchdRestart(agent, plist('<key>AbandonProcessGroup</key><true/>'), PRINT, 4242, 'neko');
    expect(plan.commands).toEqual([{ command: 'launchctl', args: ['kickstart', '-k', 'gui/501/com.ludiars.excubitor'] }]);
  });

  it('signals the verified daemon supervisor so KeepAlive restarts it without root', () => {
    const plan = planLaunchdRestart(daemon, daemonPlist, PRINT, 4242, 'neko');
    expect(plan.commands).toEqual([{ command: 'kill', args: ['-TERM', '4242'] }]);
  });

  it('refuses to signal a pid that launchd does not report for the job', () => {
    expect(() => planLaunchdRestart(daemon, daemonPlist, PRINT, 9999, 'neko')).toThrow(/identity mismatch/);
  });

  it('refuses a daemon owned by another account', () => {
    expect(() => planLaunchdRestart(daemon, daemonPlist, PRINT, 4242, 'someone')).toThrow(/current user/);
  });

  it('refuses a daemon without KeepAlive, which would stay down after SIGTERM', () => {
    const noKeepAlive = plist('<key>UserName</key><string>neko</string><key>AbandonProcessGroup</key><true/>');
    expect(() => planLaunchdRestart(daemon, noKeepAlive, PRINT, 4242, 'neko')).toThrow(/KeepAlive/);
  });

  it('refuses a job that would take managed services down with the supervisor', () => {
    const noAbandon = plist('<key>UserName</key><string>neko</string><key>KeepAlive</key><true/>');
    expect(() => planLaunchdRestart(daemon, noAbandon, PRINT, 4242, 'neko')).toThrow(/AbandonProcessGroup/);
  });
});
