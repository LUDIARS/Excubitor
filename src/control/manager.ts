import pino from 'pino';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type Service } from '../catalog/loader.js';
import { controlDockerCompose, type ControlAction, type ControlResult } from './docker-compose.js';
import { spawnService, killService, getRunningProcess } from '../process/manager.js';
import { resolveInjectEnv } from '../process/inject.js';
import { ensureTail } from '../log/docker-tail.js';

const logger = pino({ name: 'excubitor.control' });

/**
 * runtime に応じた control 呼び出しを dispatch する。
 *
 * - docker-compose: docker compose up/stop/restart
 * - node / dev-process-md: ProcessManager spawn / kill
 * - docker (raw): v0.2 で対応予定
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
    // catalog.infisical.inject=true なら Infisical から secret を fetch して
    // docker compose 子プロセスの env として渡す。 compose 内の `${VAR}` 展開で
    // container env まで伝播する (docker-compose.yaml に該当 env の expose が必要)。
    let composeEnv: Record<string, string> = env;
    try {
      const injected = await resolveInjectEnv(svc);
      composeEnv = { ...injected, ...env };
    } catch (err) {
      return { ok: false, stdout: '', stderr: (err as Error).message, exit_code: -1, command: 'resolveInjectEnv' };
    }
    result = await controlDockerCompose(svc, action, composeEnv);
    if (result.ok && (action === 'start' || action === 'restart')) {
      const primary = svc.container_names?.[0];
      if (primary) ensureTail(svc.code, primary);
    }
  } else if (svc.runtime === 'node' || svc.runtime === 'dev-process-md') {
    logger.info({ code: svc.code, action, actor }, 'control invoke (process)');
    result = await controlProcess(svc, action, env);
  } else {
    const message = `runtime=${svc.runtime} の control は v0.1 では未実装`;
    logger.warn({ code: svc.code, runtime: svc.runtime, action }, message);
    result = { ok: false, stdout: '', stderr: message, exit_code: -1, command: '(not implemented)' };
  }

  logger.info({ code: svc.code, action, ok: result.ok, exit_code: result.exit_code }, 'control complete');

  await db.execute(sql`
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
      })}::jsonb
    )
  `);

  return result;
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
      } catch (err) {
        return { ok: false, stdout: '', stderr: (err as Error).message, exit_code: -1, command: 'resolveInjectEnv' };
      }
      const p = await spawnService(svc, { env });
      return {
        ok: true,
        stdout: `spawned pid=${p.child.pid ?? '?'}`,
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
      } catch (err) {
        return { ok: false, stdout: '', stderr: (err as Error).message, exit_code: -1, command: 'resolveInjectEnv' };
      }
      const p = await spawnService(svc, { env });
      return {
        ok: true,
        stdout: `restarted pid=${p.child.pid ?? '?'}`,
        stderr: '',
        exit_code: 0,
        command: `restart ${svc.code}`,
      };
    }
  }
}
