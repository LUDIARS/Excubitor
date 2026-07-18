import { createNamedLogger } from '../shared/logger.js';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type Service } from '../catalog/loader.js';
import { controlDockerCompose, type ControlAction, type ControlResult } from './docker-compose.js';
import { spawnService, killService, getRunningProcess } from '../process/manager.js';
import { resolveInjectEnv } from '../process/inject.js';
import { ensureTail } from '../log/docker-tail.js';
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
    try {
      const injected = await resolveInjectEnv(svc);
      composeEnv = { ...injected, ...env };
      if (action === 'start' || action === 'restart') assertStartupEnv(svc, composeEnv);
    } catch (err) {
      return { ok: false, stdout: '', stderr: (err as Error).message, exit_code: -1, command: 'resolveStartupEnv' };
    }
    const build = await runControlBuild(svc, action);
    if (build?.ok === false) return build;
    result = await controlDockerCompose(svc, action, composeEnv);
    if (build && result.ok) {
      result = { ...result, stdout: `build ok\n${result.stdout}`.trim() };
    }
    if (result.ok && (action === 'start' || action === 'restart')) {
      const primary = svc.container_names?.[0];
      if (primary) ensureTail(svc.code, primary);
    }
  } else if (svc.runtime === 'node' || svc.runtime === 'dev-process-md' || svc.runtime === 'app') {
    logger.info({ code: svc.code, action, actor }, 'control invoke (process)');
    result = await controlProcess(svc, action, env);
  } else {
    const message = `runtime=${svc.runtime} control is not implemented in v0.1`;
    logger.warn({ code: svc.code, runtime: svc.runtime, action }, message);
    result = { ok: false, stdout: '', stderr: message, exit_code: -1, command: '(not implemented)' };
  }

  logger.info({ code: svc.code, action, ok: result.ok, exit_code: result.exit_code }, 'control complete');

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

  return result;
}

async function runControlBuild(svc: Service, action: ControlAction): Promise<ControlResult | null> {
  if (action !== 'start' && action !== 'restart') return null;
  const build = await runServiceBuild(svc, `manual-${action}`);
  if (!build.ok) {
    return { ok: false, stdout: build.stdout, stderr: build.stderr, exit_code: build.code ?? -1, command: build.command };
  }
  return build.skipped
    ? null
    : { ok: true, stdout: build.stdout, stderr: build.stderr, exit_code: build.code ?? 0, command: build.command };
}

async function controlProcess(
  svc: Service,
  action: ControlAction,
  envOverride: Record<string, string>,
): Promise<ControlResult> {
  switch (action) {
    case 'start': {
      const existing = getRunningProcess(svc.code);
      if (existing) {
        return { ok: true, stdout: 'already running', stderr: '', exit_code: 0, command: '(noop)' };
      }
      let env: Record<string, string>;
      try {
        env = { ...(await resolveInjectEnv(svc)), ...envOverride };
        assertStartupEnv(svc, env);
      } catch (err) {
        return { ok: false, stdout: '', stderr: (err as Error).message, exit_code: -1, command: 'resolveStartupEnv' };
      }
      const build = await runControlBuild(svc, action);
      if (build?.ok === false) return build;
      let spawnError: string | null = null;
      const p = await spawnService(svc, { env }).catch((err: unknown) => {
        spawnError = err instanceof Error ? err.message : String(err);
        return null;
      });
      if (!p) {
        return { ok: false, stdout: '', stderr: spawnError ?? 'start failed', exit_code: -1, command: `spawn ${svc.runtime}:${svc.code}` };
      }
      const buildPrefix = build ? 'build ok\n' : '';
      return {
        ok: true,
        stdout: `${buildPrefix}spawned pid=${p.child.pid ?? '?'}`,
        stderr: '',
        exit_code: 0,
        command: `spawn ${svc.runtime}:${svc.code}`,
      };
    }
    case 'stop': {
      const ok = await killService(svc.code);
      return {
        ok,
        stdout: ok ? 'sent SIGTERM' : 'not running',
        stderr: '',
        exit_code: ok ? 0 : -1,
        command: `kill ${svc.code}`,
      };
    }
    case 'restart': {
      await killService(svc.code);
      await new Promise((r) => setTimeout(r, 500));
      let env: Record<string, string>;
      try {
        env = { ...(await resolveInjectEnv(svc)), ...envOverride };
        assertStartupEnv(svc, env);
      } catch (err) {
        return { ok: false, stdout: '', stderr: (err as Error).message, exit_code: -1, command: 'resolveStartupEnv' };
      }
      const build = await runControlBuild(svc, action);
      if (build?.ok === false) return build;
      let spawnError: string | null = null;
      const p = await spawnService(svc, { env }).catch((err: unknown) => {
        spawnError = err instanceof Error ? err.message : String(err);
        return null;
      });
      if (!p) {
        return { ok: false, stdout: '', stderr: spawnError ?? 'restart failed', exit_code: -1, command: `restart ${svc.code}` };
      }
      const buildPrefix = build ? 'build ok\n' : '';
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




