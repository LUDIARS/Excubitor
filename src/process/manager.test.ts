import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Service } from '../catalog/loader.js';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  dbRun: vi.fn(),
  startProcessLog: vi.fn(() => ({ stdoutFd: 10, stderrFd: 11 })),
  stopProcessLog: vi.fn(),
  runServiceBuild: vi.fn(),
  verifyProcessIdentity: vi.fn(),
  waitForProcessIdentityOutcome: vi.fn(),
  loggerWarn: vi.fn(),
  prepareSpawnEnv: vi.fn(async (_svc: unknown, env: Record<string, string>) => env),
  spawnsOutsideJob: vi.fn(),
}));

vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
// 起動経路は実行 OS で決まる (win32 = job-breakaway 固定)。どの OS で走らせても両経路を
// 検証できるよう、判定だけを差し替える。本番コードに経路を選ぶ手段は無い (§17.6)。
vi.mock('./spawn-strategy.js', () => ({ spawnsOutsideJob: mocks.spawnsOutsideJob }));
vi.mock('../shared/logger.js', () => ({
  createNamedLogger: () => ({ info: vi.fn(), warn: mocks.loggerWarn, error: vi.fn() }),
}));
vi.mock('../db/client.js', () => ({ db: () => ({ run: mocks.dbRun }) }));
vi.mock('./dev-process-md.js', () => ({ resolveDevProcessCommand: vi.fn() }));
vi.mock('../scanner/git.js', () => ({
  readGitInfo: vi.fn(async () => ({
    branch: null,
    hash: null,
    dirty: null,
    package_version: null,
  })),
}));
vi.mock('../shared/exec.js', () => ({
  execCapture: vi.fn(async () => ({ ok: true, code: 0, stdout: '', stderr: '' })),
}));
vi.mock('../log/process-file.js', () => ({
  startProcessLog: mocks.startProcessLog,
  stopProcessLog: mocks.stopProcessLog,
  ensureProcessLogPaths: vi.fn(() => ({
    stdoutPath: 'data/process-logs/test.out.log',
    stderrPath: 'data/process-logs/test.err.log',
  })),
}));
vi.mock('./build.js', () => ({ runServiceBuild: mocks.runServiceBuild }));
vi.mock('./startup-env.js', () => ({ assertStartupEnv: vi.fn() }));
vi.mock('../auto_fix/concordia-dispatch.js', () => ({ maybeDispatchCrashFixToConcordia: vi.fn() }));
vi.mock('../deploy/deployed-dispatch.js', () => ({ dispatchServiceDeployment: vi.fn() }));
vi.mock('./hot-reload.js', () => ({ assertHotReloadAllowed: vi.fn(async () => undefined) }));
vi.mock('./cernere-launch-credential.js', () => ({
  prepareSpawnEnv: mocks.prepareSpawnEnv,
}));
vi.mock('./identity.js', () => ({
  verifyProcessIdentity: mocks.verifyProcessIdentity,
  waitForProcessIdentityOutcome: mocks.waitForProcessIdentityOutcome,
}));

import {
  adoptProcess,
  getManagedPid,
  inheritableSupervisorEnv,
  isManaged,
  isPidManaged,
  killService,
  resumeProcessRestarts,
  spawnService,
  validateManagedProcess,
} from './manager.js';
import { dispatchServiceDeployment } from '../deploy/deployed-dispatch.js';

describe('inheritableSupervisorEnv', () => {
  it('drops the Excubitor machine identity credential so children cannot fetch other projects', () => {
    // supervisor は service-runner-infisical.ts で自身の identity を process.env に載せる。
    // これが素通しで継承されると、relay が project/key 単位に絞った意味が無くなる。
    const env = inheritableSupervisorEnv({
      INFISICAL_SITE_URL: 'https://infisical.example.com',
      INFISICAL_ENVIRONMENT: 'dev',
      INFISICAL_CLIENT_ID: 'client-id',
      INFISICAL_CLIENT_SECRET: 'client-secret',
      PATH: '/usr/bin',
      UNSET: undefined,
    });

    expect(env).toEqual({
      INFISICAL_SITE_URL: 'https://infisical.example.com',
      INFISICAL_ENVIRONMENT: 'dev',
      PATH: '/usr/bin',
    });
  });
});

describe('process manager lifecycle hardening', () => {
  beforeEach(() => {
    // 既存のライフサイクル検証は ChildProcess ベースの挙動 (POSIX の child 起動) を対象にする。
    // win32 の job-breakaway は専用の describe で検証する。
    vi.clearAllMocks();
    mocks.spawnsOutsideJob.mockReturnValue(false);
    mocks.dbRun.mockReset();
    mocks.verifyProcessIdentity.mockResolvedValue(true);
    mocks.prepareSpawnEnv.mockImplementation(async (_svc: unknown, env: Record<string, string>) => env);
    resumeProcessRestarts();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('reports whether a pid is already owned by an adopted service', async () => {
    adoptProcess('pid-owner', {
      pid: 9190,
      startedAt: new Date('2026-07-12T00:00:00.000Z'),
      verified: true,
    });

    expect(isPidManaged(9190)).toBe(true);
    expect(isPidManaged(9191)).toBe(false);
    await expect(killService('pid-owner')).resolves.toBe(true);
  });

  it('rejects an asynchronous spawn error and cleans process/log state', async () => {
    const child = fakeChild(9101);
    mocks.spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit('error', new Error('ENOENT')));
      return child;
    });

    await expect(spawnService(service('spawn-error'))).rejects.toThrow('ENOENT');

    expect(isManaged('spawn-error')).toBe(false);
    expect(mocks.stopProcessLog).toHaveBeenCalledWith('spawn-error');
    expect(mocks.dbRun.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps a real spawned process successful when only running-state promotion fails', async () => {
    const child = fakeChild(9103);
    mocks.spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });
    let dbCalls = 0;
    mocks.dbRun.mockImplementation(() => {
      dbCalls += 1;
      if (dbCalls === 6) throw new Error('running state write failed');
    });

    await expect(spawnService(service('running-state-failure'))).resolves.toMatchObject({ child });
    expect(isManaged('running-state-failure')).toBe(true);

    const stopping = killService('running-state-failure');
    child.emit('exit', null, 'SIGTERM');
    await expect(stopping).resolves.toBe(true);
  });

  it('dispatches the deployment event for a service by default', async () => {
    const child = fakeChild(9105);
    mocks.spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });

    await spawnService(service('deploy-notify-default'));
    expect(dispatchServiceDeployment).toHaveBeenCalledWith(expect.objectContaining({ code: 'deploy-notify-default' }));

    const stopping = killService('deploy-notify-default');
    child.emit('exit', null, 'SIGTERM');
    await stopping;
  });

  it('does not dispatch the deployment event when the catalog opts out', async () => {
    const child = fakeChild(9106);
    mocks.spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });

    await spawnService({ ...service('deploy-notify-opt-out'), deploy_notify: false });
    expect(dispatchServiceDeployment).not.toHaveBeenCalled();

    const stopping = killService('deploy-notify-opt-out');
    child.emit('exit', null, 'SIGTERM');
    await stopping;
  });

  it('suppresses restart policy for an explicit stop and waits for exit handling', async () => {
    vi.useFakeTimers();
    const child = fakeChild(9102);
    mocks.spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });

    await spawnService(service('manual-stop'), { restartPolicy: 'always' });
    const stopping = killService('manual-stop');
    child.emit('exit', null, 'SIGTERM');
    await expect(stopping).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(isManaged('manual-stop')).toBe(false);
    expect(mocks.runServiceBuild).not.toHaveBeenCalled();
  });

  it('prunes a stale adopted PID identity and records a crash', async () => {
    const startedAt = new Date('2026-07-12T00:00:00.000Z');
    adoptProcess('stale-adopted', { pid: 9191, startedAt, verified: true });
    mocks.verifyProcessIdentity.mockResolvedValueOnce(false);

    await expect(validateManagedProcess('stale-adopted')).resolves.toBe(false);

    expect(isManaged('stale-adopted')).toBe(false);
    expect(mocks.verifyProcessIdentity).toHaveBeenCalledWith(9191, startedAt);
    expect(mocks.dbRun).toHaveBeenCalledTimes(2);
  });

  it('does not delete an adopted identity replaced during asynchronous validation', async () => {
    let resolveVerification = (_verified: boolean): void => undefined;
    mocks.verifyProcessIdentity.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
      resolveVerification = resolve;
    }));
    adoptProcess('replaced-adopted', {
      pid: 9192,
      startedAt: new Date('2026-07-12T00:00:00.000Z'),
      verified: true,
    });

    const validating = validateManagedProcess('replaced-adopted');
    adoptProcess('replaced-adopted', {
      pid: 9193,
      startedAt: new Date('2026-07-12T00:01:00.000Z'),
      verified: true,
    });
    resolveVerification(false);

    await expect(validating).resolves.toBe(true);
    expect(getManagedPid('replaced-adopted')).toBe(9193);
    await expect(killService('replaced-adopted')).resolves.toBe(true);
  });

  it('prunes a spawned child that has already exited', async () => {
    const child = fakeChild(9194);
    mocks.spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });
    await spawnService(service('already-exited'));
    child.exitCode = 3;

    await expect(validateManagedProcess('already-exited')).resolves.toBe(false);

    expect(isManaged('already-exited')).toBe(false);
  });

  it('cancels a pending crash restart when an explicit stop arrives during backoff', async () => {
    vi.useFakeTimers();
    const child = fakeChild(9195);
    mocks.spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });
    await spawnService(service('backoff-stop'), { restartPolicy: 'always' });
    child.exitCode = 1;
    child.emit('exit', 1, null);
    for (let index = 0; index < 4; index += 1) await Promise.resolve();

    await expect(killService('backoff-stop')).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it('reserves a service before asynchronous preparation so concurrent starts cannot overwrite it', async () => {
    const child = fakeChild(2_147_483_647);
    mocks.spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });

    const first = spawnService(service('concurrent-start'), { restartPolicy: 'no' });
    const second = spawnService(service('concurrent-start'), { restartPolicy: 'no' });

    await expect(second).rejects.toThrow('already managed or being started');
    await expect(first).resolves.toMatchObject({ child });
    const stopping = killService('concurrent-start');
    child.emit('exit', null, 'SIGTERM');
    await expect(stopping).resolves.toBe(true);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(mocks.spawn).toHaveBeenCalledWith(
      // §17.4.2: 先頭語は実行ファイルへ解決してから渡す (win32 では node.exe の絶対パス)。
      expect.stringMatching(/(^|[\\/])node(\.exe)?$/),
      ['demo.js'],
      // child 起動は POSIX 専用で、supervisor 再起動を生き延びるよう常に detached (§17.6)。
      expect.objectContaining({
        detached: true,
        windowsHide: true,
        env: expect.objectContaining({
          EXCUBITOR_SERVICE_VERSION: '0.0.0+unversioned',
          VITE_EXCUBITOR_SERVICE_VERSION: '0.0.0+unversioned',
        }),
      }),
    );
    // 解決できた入口に cmd.exe を挟まない。挟むと返り pid が cmd.exe になり pid 契約が破れる。
    expect(mocks.spawn.mock.calls[0]![2]).toMatchObject({ shell: false });
  });

  it('does not hand the supervisor Infisical credential to the spawned child', async () => {
    vi.stubEnv('INFISICAL_SITE_URL', 'https://infisical.example.com');
    vi.stubEnv('INFISICAL_CLIENT_ID', 'client-id');
    vi.stubEnv('INFISICAL_CLIENT_SECRET', 'client-secret');
    const child = fakeChild(2_147_483_647);
    mocks.spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });

    await spawnService(service('identity-scope'), { restartPolicy: 'no' });

    const baseEnv = mocks.prepareSpawnEnv.mock.calls[0]![1] as Record<string, string>;
    expect(baseEnv.INFISICAL_CLIENT_ID).toBeUndefined();
    expect(baseEnv.INFISICAL_CLIENT_SECRET).toBeUndefined();
    expect(baseEnv.INFISICAL_SITE_URL).toBe('https://infisical.example.com');

    const stopping = killService('identity-scope');
    child.emit('exit', null, 'SIGTERM');
    await expect(stopping).resolves.toBe(true);
  });

  it('cancels a reserved start while credential preparation is in flight', async () => {
    let resolveCredential = (_env: Record<string, string>): void => undefined;
    mocks.prepareSpawnEnv.mockImplementationOnce(() => new Promise<Record<string, string>>((resolve) => {
      resolveCredential = resolve;
    }));

    const starting = spawnService(service('credential-stop'), { restartPolicy: 'no' });
    await vi.waitFor(() => expect(mocks.prepareSpawnEnv).toHaveBeenCalled());
    const stopping = killService('credential-stop');
    resolveCredential({});

    await expect(starting).rejects.toThrow('canceled by a newer lifecycle request');
    await expect(stopping).resolves.toBe(true);
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(isManaged('credential-stop')).toBe(false);
  });

  it('terminates a child whose spawn completes after an explicit stop', async () => {
    const child = fakeChild(2_147_483_647);
    child.kill.mockImplementation((signal: NodeJS.Signals = 'SIGTERM') => {
      queueMicrotask(() => {
        child.signalCode = signal;
        child.emit('exit', null, signal);
      });
      return true;
    });
    mocks.spawn.mockReturnValue(child);

    const starting = spawnService(service('spawn-complete-stop'), { restartPolicy: 'no' });
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
    const stopping = killService('spawn-complete-stop');
    child.emit('spawn');

    await expect(starting).rejects.toThrow('canceled by a newer lifecycle request');
    await expect(stopping).resolves.toBe(true);
    expect(isManaged('spawn-complete-stop')).toBe(false);
    expect(mocks.stopProcessLog).toHaveBeenCalledWith('spawn-complete-stop');
  });
});

function fakeChild(pid: number): EventEmitter & {
  pid: number;
  unref: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
} {
  return Object.assign(new EventEmitter(), {
    pid,
    unref: vi.fn(),
    kill: vi.fn(() => true),
    exitCode: null,
    signalCode: null,
  });
}

function service(code: string): Service {
  return {
    code,
    name: code,
    runtime: 'node',
    cwd: process.cwd(),
    command: 'node demo.js',
    disabled: false,
    develop_derived: false,
    monitor_only: false,
    depends_on: [],
    autostart: false,
    allow_hot_reload: false,
    restart_policy: 'always',
    max_restart: 5,
    required_env: [],
  } as Service;
}

describe('job-breakaway spawn (win32)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.spawnsOutsideJob.mockReturnValue(true);
    mocks.dbRun.mockReset();
    mocks.prepareSpawnEnv.mockImplementation(async (_svc: unknown, env: Record<string, string>) => env);
    resumeProcessRestarts();
  });

  /** WMI は短命 launcher の pid を返し、実プロセスの pid は launcher が結果へ書く。 */
  function breakawayOptions(launcherPid: number, servicePid: number) {
    return {
      runPowerShell: vi.fn(async () => `{"ReturnValue":0,"ProcessId":${launcherPid}}`),
      readResult: async () => `{"pid":${servicePid}}`,
      removeResult: async () => undefined,
      resultPath: 'data/process-logs/.breakaway-test.json',
    };
  }

  it('spawns through the breakaway runner and registers the service pid as adopted', async () => {
    const startedAt = new Date();
    mocks.waitForProcessIdentityOutcome.mockResolvedValue({ ok: true, identity: { pid: 4321, startedAt, verified: true } });
    const breakaway = breakawayOptions(999, 4321);
    const runPowerShell = breakaway.runPowerShell;

    const spawned = await spawnService(service('breakaway-ok'), { breakaway });

    expect(spawned).toMatchObject({ code: 'breakaway-ok', child: null, pid: 4321 });
    // ChildProcess を作らない (node:child_process の spawn は powershell 差し替えで未使用)。
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(runPowerShell).toHaveBeenCalledTimes(1);
    // adopted (pid 管理) として登録され、stop / reaper の対象になる。
    expect(isManaged('breakaway-ok')).toBe(true);
    expect(getManagedPid('breakaway-ok')).toBe(4321);
    // 環境変数 (credential を含む) がコマンドラインに載らない: script は stdin 渡し。
    const script = (runPowerShell.mock.calls[0] as unknown[])[0] as string;
    expect(script).toContain('FromBase64String');
  });

  it('hands runtime=app the exec path and args verbatim (no command-line quoting to get wrong)', async () => {
    const startedAt = new Date();
    mocks.waitForProcessIdentityOutcome.mockResolvedValue({ ok: true, identity: { pid: 4323, startedAt, verified: true } });
    const breakaway = breakawayOptions(998, 4323);
    const runPowerShell = breakaway.runPowerShell;
    const app = {
      ...service('breakaway-app'),
      runtime: 'app',
      cwd: undefined,
      command: undefined,
      exec: 'E:\\Program Files\\hora\\hora.exe',
      exec_args: ['--profile', 'default one'],
    } as unknown as Service;

    await spawnService(app, { breakaway });

    // launcher が Node の spawn へ argv をそのまま渡すので、child 戦略 (shell:false) と
    // 同じ引数分割になる。 コマンドラインへ畳まないため引用のずれが起きない。
    const script = (runPowerShell.mock.calls[0] as unknown[])[0] as string;
    const encoded = /FromBase64String\('([^']+)'\)/.exec(script)![1]!;
    const payload = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as {
      commandLine: string;
      env: string[];
    };
    // 常駐する cmd.exe を作らない: コマンドラインは launcher の起動だけ。
    expect(payload.commandLine).toContain('breakaway-launcher-main');
    expect(payload.commandLine).not.toContain('hora.exe');
    const specEntry = payload.env.find((line) => line.startsWith('EXCUBITOR_BREAKAWAY_SPEC='))!;
    const launchSpec = JSON.parse(
      Buffer.from(specEntry.slice('EXCUBITOR_BREAKAWAY_SPEC='.length), 'base64').toString('utf8'),
    ) as { command: string; args: string[]; shell: boolean };
    expect(launchSpec).toEqual(
      expect.objectContaining({
        command: 'E:\\Program Files\\hora\\hora.exe',
        args: ['--profile', 'default one'],
        shell: false,
      }),
    );
  });

  it('fails fast and points at the orphan when the identity is unreadable', async () => {
    // pid は生き残りうるので、 §17.4.3 の回収手順へ回せる文言でなければならない。
    mocks.waitForProcessIdentityOutcome.mockResolvedValue({ ok: false, reason: 'unreadable' });

    await expect(
      spawnService(service('breakaway-dead'), { breakaway: breakawayOptions(997, 4322) }),
    ).rejects.toThrow(/could not be verified after breakaway spawn \(pid=4322\)[\s\S]*reclaim pid 4322/);
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      { code: 'breakaway-dead', pid: 4322, reason: 'unreadable' },
      expect.stringContaining('pid may survive as an orphan'),
    );
    expect(isManaged('breakaway-dead')).toBe(false);
  });

  it('says the process exited when the pid is already gone', async () => {
    // 回収すべき pid が無い側。 調べるのは stderr であって孤児ではない。
    mocks.waitForProcessIdentityOutcome.mockResolvedValue({ ok: false, reason: 'exited' });

    await expect(
      spawnService(service('breakaway-dead'), { breakaway: breakawayOptions(997, 4322) }),
    ).rejects.toThrow(/exited immediately after breakaway spawn \(pid=4322\)/);
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      { code: 'breakaway-dead', pid: 4322, reason: 'exited' },
      expect.stringContaining('no orphan pid to reclaim'),
    );
    expect(isManaged('breakaway-dead')).toBe(false);
  });

  it('surfaces the launcher failure reason instead of an anonymous immediate exit', async () => {
    await expect(
      spawnService(service('breakaway-launch-failed'), {
        breakaway: {
          runPowerShell: vi.fn(async () => '{"ReturnValue":0,"ProcessId":996}'),
          readResult: async () => '{"error":"spawn npm ENOENT"}',
          removeResult: async () => undefined,
          resultPath: 'data/process-logs/.breakaway-test.json',
        },
      }),
    ).rejects.toThrow(/spawn npm ENOENT/);
    expect(isManaged('breakaway-launch-failed')).toBe(false);
  });
});
