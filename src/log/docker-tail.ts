/**
 * docker logs -f --tail 0 を子プロセスとして起動し、 line を logbus に publish する。
 * 1 container = 1 tailer。 container が止まると tailer も自然終了。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import pino from 'pino';
import { publish } from './bus.js';

const logger = pino({ name: 'excubitor.docker-tail' });

interface TailerState {
  serviceCode: string;
  container: string;
  child: ChildProcess;
}

const tailers = new Map<string, TailerState>(); // key: service_code

export function isTailingService(serviceCode: string): boolean {
  return tailers.has(serviceCode);
}

export function ensureTail(serviceCode: string, containerName: string): void {
  const existing = tailers.get(serviceCode);
  if (existing && existing.container === containerName) return;
  if (existing) stopTail(serviceCode);

  const child = spawn('docker', ['logs', '-f', '--tail', '20', containerName], {
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const state: TailerState = { serviceCode, container: containerName, child };
  tailers.set(serviceCode, state);
  logger.info({ code: serviceCode, container: containerName, pid: child.pid }, 'docker tail started');

  attachReader(state, child, 'stdout');
  attachReader(state, child, 'stderr');

  child.on('exit', () => {
    tailers.delete(serviceCode);
    logger.info({ code: serviceCode, container: containerName }, 'docker tail exited');
  });
  child.on('error', (err) => {
    logger.warn({ code: serviceCode, container: containerName, err: err.message }, 'docker tail error');
  });
}

export function stopTail(serviceCode: string): void {
  const t = tailers.get(serviceCode);
  if (!t) return;
  try { t.child.kill('SIGTERM'); } catch { /* noop */ }
  tailers.delete(serviceCode);
}

function attachReader(state: TailerState, child: ChildProcess, channel: 'stdout' | 'stderr'): void {
  const stream = child[channel];
  if (!stream) return;
  let buf = '';
  stream.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line.length > 0) {
        void publish({
          service_code: state.serviceCode,
          channel,
          ts: new Date(),
          line,
        });
      }
    }
  });
}
