import { createNamedLogger } from '../shared/logger.js';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type Service } from '../catalog/loader.js';
import { controlDockerCompose, type ControlAction, type ControlResult } from './docker-compose.js';
import {
  cancelServiceRestart,
  killService,
  markServiceRunning,
  markServiceStopped,
  spawnService,
  validateManagedProcess,
  waitForPendingSpawn,
} from '../process/manager.js';
import { resolveInjectEnv } from '../process/inject.js';
import { runServiceBuild } from '../process/build.js';
import { assertStartupEnv } from '../process/startup-env.js';

const logger = createNamedLogger('excubitor.control');

/**
 * runtime に応じぁEcontrol 呼び出しを dispatch する、E
 *
 * - docker-compose: docker compose up/stop/restart
 * - node / dev-process-md / app: ProcessManager spawn / kill
 * - docker (raw): v0.2 で対応予宁E
 */
export async function controlService(
  svc: Service,
  action: ControlAction,
  actor: string,
  env: Record<string, string> = {},
): Promise<ControlResult> {
  let result: ControlResult;

  if (svc.runtime === 'docker-compose') {
    logger.info({ code: svc.code, action, actor }, 'control invoke (compose)');
    let composeEnv: Record<string, string> = env;
    if (action === 'start' || action === 'restart') {
      try {
        const injected = await resolveInjectEnv(svc);
        composeEnv = { ...injected, ...env };
        assertStartupEnv(svc, composeEnv);
      } catch (err) {
        return { ok: false, stdout: '', stderr: (err as Error).message, exit_code: -1, command: 'resolveStartupEnv' };
      }
    }
    result = await controlDockerCompose(svc, action, composeEnv);
  } else if (svc.runtime === 'node' || svc.runtime === 'dev-process-md' || svc.runtime === 'app') {
    logger.info({ code: svc.code, action, actor }, 'control invoke (process)');
    result = await controlProcess(svc, action, env);
  } else {
    const message = `runtime=${svc.runtime} control is not implemented in v0.1`;
    logger.warn({ code: svc.code, runtime: svc.runtime, action }, message);
    result = { ok: false, stdout: '', stderr: message, exit_code: -1, command: '(not implemented)' };
  }

  logger.info({ code: svc.code, action, ok: result.ok, exit_code: result.exit_code }, 'control complete');

  try {
    db().run(sql`
      INSERT INTO audit_log (actor, action, target_type, target_id, payload)
      VALUES (
        ${actor},
        ${'service.' + action},
        ${'service'},
        ${svc.code},
        ${JSON.stringify({
          ok: result.ok,
          exit_code: result.exit_code,
          command: result.command,
          stdout_tail: result.stdout.slice(-500),
          stderr_tail: result.stderr.slice(-500),
        })}
      )
    `);
  } catch (error) {
    // The lifecycle result is already real at this point. An observability write
    // must not turn a successful process transition into a reported failure.
    logger.error(
      { code: svc.code, action, actor, err: error instanceof Error ? error.message : String(error) },
      'control audit write failed',
    );
  }

  return result;
}

async function controlProcess(
  svc: Service,
  action: ControlAction,
  envOverride: Record<string, string>,
): Promise<ControlResult> {
  switch (action) {
    case 'start': {
      await waitForPendingSpawn(svc.code);
      if (await validateManagedProcess(svc.code)) {
        return { ok: true, stdout: 'already running', stderr: '', exit_code: 0, command: '(noop)' };
      }
      const generation = markServiceRunning(svc.code);
      let env: Record<string, string>;
      try {
        env = { ...(await resolveInjectEnv(svc)), ...envOverride };
        assertStartupEnv(svc, env);
      } catch (err) {
        markServiceStopped(svc.code);
        return { ok: false, stdout: '', stderr: (err as Error).message, exit_code: -1, command: 'resolveStartupEnv' };
      }
      const build = await runServiceBuild(svc, 'manual-start');
      if (!build.ok) {
        markServiceStopped(svc.code);
        return { ok: false, stdout: build.stdout, stderr: build.stderr, exit_code: build.code ?? -1, command: build.command };
      }
      let spawnError: string | null = null;
      const p = await spawnService(svc, { env, expectedGeneration: generation }).catch((err: unknown) => {
        spawnError = err instanceof Error ? err.message : String(err);
        return null;
      });
      if (!p) {
        markServiceStopped(svc.code);
        return { ok: false, stdout: '', stderr: spawnError ?? 'start failed', exit_code: -1, command: `spawn ${svc.runtime}:${svc.code}` };
      }
      const buildPrefix = build.skipped ? '' : 'build ok\n';
      return {
        ok: true,
        stdout: `${buildPrefix}spawned pid=${p.child.pid ?? '?'}`,
        stderr: '',
        exit_code: 0,
        command: `spawn ${svc.runtime}:${svc.code}`,
      };
    }
    case 'stop': {
      try {
        const ok = await killService(svc.code);
        return {
          ok,
          stdout: ok ? 'stopped' : 'not running',
          stderr: ok ? '' : `service ${svc.code} is not managed`,
          exit_code: ok ? 0 : -1,
          command: `kill ${svc.code}`,
        };
      } catch (err) {
        return {
          ok: false,
          stdout: '',
          stderr: err instanceof Error ? err.message : String(err),
          exit_code: -1,
          command: `kill ${svc.code}`,
        };
      }
    }
    case 'restart': {
      cancelServiceRestart(svc.code);
      await waitForPendingSpawn(svc.code);
      let env: Record<string, string>;
      try {
        env = { ...(await resolveInjectEnv(svc)), ...envOverride };
        assertStartupEnv(svc, env);
      } catch (err) {
        return { ok: false, stdout: '', stderr: (err as Error).message, exit_code: -1, command: 'resolveStartupEnv' };
      }
      const build = await runServiceBuild(svc, 'manual-restart');
      if (!build.ok) {
        return { ok: false, stdout: build.stdout, stderr: build.stderr, exit_code: build.code ?? -1, command: build.command };
      }
      if (await validateManagedProcess(svc.code)) {
        try {
          if (!(await killService(svc.code))) {
            return { ok: false, stdout: '', stderr: `service ${svc.code} stopped before restart`, exit_code: -1, command: `restart ${svc.code}` };
          }
        } catch (err) {
          return {
            ok: false,
            stdout: '',
            stderr: err instanceof Error ? err.message : String(err),
            exit_code: -1,
            command: `restart ${svc.code}`,
          };
        }
      }
      const generation = markServiceRunning(svc.code);
      let spawnError: string | null = null;
      const p = await spawnService(svc, { env, expectedGeneration: generation }).catch((err: unknown) => {
        spawnError = err instanceof Error ? err.message : String(err);
        return null;
      });
      if (!p) {
        markServiceStopped(svc.code);
        return { ok: false, stdout: '', stderr: spawnError ?? 'restart failed', exit_code: -1, command: `restart ${svc.code}` };
      }
      const buildPrefix = build.skipped ? '' : 'build ok\n';
      return {
        ok: true,
        stdout: `${buildPrefix}restarted pid=${p.child.pid ?? '?'}`,
        stderr: '',
        exit_code: 0,
        command: `restart ${svc.code}`,
      };
    }
  }
}



