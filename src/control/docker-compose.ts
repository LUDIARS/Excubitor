import { spawn } from 'node:child_process';
import { type Service } from '../catalog/loader.js';

export const DOCKER_CONTROL_TIMEOUT_MS = 30_000;
export const DOCKER_OUTPUT_LIMIT_BYTES = 64 * 1024;
export const DOCKER_TERMINATION_GRACE_MS = 5_000;

export type ControlAction = 'start' | 'stop' | 'restart';

export interface ControlResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exit_code: number;
  command: string;
}

/**
 * Runs a bounded docker compose lifecycle command.
 * Startup environment values are passed only through the child process env.
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
  return new Promise((resolve) => {
    const proc = spawn('docker', args, {
      shell: false,
      env: { ...process.env, ...extraEnv },
    });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    let timedOut = false;
    let forced = false;
    let commandTimer: NodeJS.Timeout | null = null;
    let terminationTimer: NodeJS.Timeout | null = null;
    const command = `docker ${args.join(' ')}`;
    const finish = (result: ControlResult): void => {
      if (settled) return;
      settled = true;
      if (commandTimer) clearTimeout(commandTimer);
      if (terminationTimer) clearTimeout(terminationTimer);
      resolve(result);
    };
    const timedOutResult = (diagnostic?: string): ControlResult => ({
      ok: false,
      stdout: capturedText(stdout, stdoutTruncated),
      stderr: appendDiagnostic(
        capturedText(stderr, stderrTruncated),
        diagnostic ?? `[timeout after ${DOCKER_CONTROL_TIMEOUT_MS}ms${forced ? '; forced termination' : ''}]`,
      ),
      exit_code: -1,
      command,
    });
    commandTimer = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGTERM'); } catch { /* close/error will settle or force escalation will follow */ }
      terminationTimer = setTimeout(() => {
        forced = true;
        try { proc.kill('SIGKILL'); } catch { /* final grace still verifies the close event */ }
        terminationTimer = setTimeout(() => {
          finish(timedOutResult(
            `[timeout after ${DOCKER_CONTROL_TIMEOUT_MS}ms; unable to confirm termination after SIGTERM/SIGKILL]`,
          ));
        }, DOCKER_TERMINATION_GRACE_MS);
      }, DOCKER_TERMINATION_GRACE_MS);
    }, DOCKER_CONTROL_TIMEOUT_MS);
    proc.stdout.on('data', (chunk: Buffer) => {
      ({ value: stdout, truncated: stdoutTruncated } = appendBounded(stdout, chunk, stdoutTruncated));
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      ({ value: stderr, truncated: stderrTruncated } = appendBounded(stderr, chunk, stderrTruncated));
    });
    proc.on('error', (err) => finish(timedOut
      ? timedOutResult(`[timeout after ${DOCKER_CONTROL_TIMEOUT_MS}ms; process error: ${err.message}]`)
      : {
          ok: false,
          stdout: capturedText(stdout, stdoutTruncated),
          stderr: appendDiagnostic(capturedText(stderr, stderrTruncated), err.message),
          exit_code: -1,
          command,
        }));
    proc.on('close', (code) => {
      if (timedOut) {
        finish(timedOutResult());
        return;
      }
      finish({
        ok: code === 0,
        stdout: capturedText(stdout, stdoutTruncated),
        stderr: capturedText(stderr, stderrTruncated),
        exit_code: code ?? -1,
        command,
      });
    });
  });
}

function appendBounded(
  current: Buffer<ArrayBufferLike>,
  chunk: Buffer<ArrayBufferLike>,
  alreadyTruncated: boolean,
): { value: Buffer<ArrayBufferLike>; truncated: boolean } {
  const combined = Buffer.concat([current, chunk]);
  if (combined.length <= DOCKER_OUTPUT_LIMIT_BYTES) {
    return { value: combined, truncated: alreadyTruncated };
  }
  return {
    value: combined.subarray(combined.length - DOCKER_OUTPUT_LIMIT_BYTES),
    truncated: true,
  };
}

function capturedText(value: Buffer<ArrayBufferLike>, truncated: boolean): string {
  const text = value.toString('utf8').trim();
  return truncated ? `[output truncated]\n${text}` : text;
}

function appendDiagnostic(output: string, diagnostic: string): string {
  return output ? `${output}\n${diagnostic}` : diagnostic;
}

