import { spawn } from 'node:child_process';
import { type Service } from '../catalog/loader.js';

export type ControlAction = 'start' | 'stop' | 'restart';

export interface ControlResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exit_code: number;
  command: string;
}

/**
 * docker compose 経由でサービスを操作する、E
 *
 * 実コマンド侁E
 *   docker compose -f <compose_file> up -d <service-name>...
 *   docker compose -f <compose_file> stop <service-name>...
 *   docker compose -f <compose_file> restart <service-name>...
 *
 * env オーバ�EライチE(secret injection 筁E は env 引数で受け取る、E
 */
export async function controlDockerCompose(
  svc: Service,
  action: ControlAction,
  env: Record<string, string> = {},
): Promise<ControlResult> {
  if (svc.runtime !== 'docker-compose') {
    throw new Error(`controlDockerCompose called for runtime=${svc.runtime}`);
  }
  if (!svc.compose_file) {
    throw new Error(`service ${svc.code} has no compose_file`);
  }

  const composeArgs = ['compose', '-f', svc.compose_file];

  const targets = svc.services ?? [];
  let opArgs: string[];
  switch (action) {
    case 'start':
      opArgs = ['up', '-d', ...targets];
      break;
    case 'stop':
      opArgs = ['stop', ...targets];
      break;
    case 'restart':
      opArgs = ['restart', ...targets];
      break;
  }

  return execDocker([...composeArgs, ...opArgs], env);
}

function execDocker(args: string[], extraEnv: Record<string, string>): Promise<ControlResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn('docker', args, {
      shell: false,
      env: { ...process.env, ...extraEnv },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    proc.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      resolve({
        ok: code === 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exit_code: code ?? -1,
        command: `docker ${args.join(' ')}`,
      });
    });
  });
}


