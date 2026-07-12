import { randomUUID } from 'node:crypto';
import { access, chmod, mkdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { isWindowsNamedPipe } from './endpoint.js';
import { LineTooLongError, NewlineJsonFramer } from './line-framer.js';
import {
  failedResponse,
  LOCAL_CONTROL_MAX_LINE_BYTES,
  LocalControlRequestSchema,
  type LocalControlRequest,
  type LocalControlResponse,
} from './protocol.js';

export interface LocalControlDispatch {
  response: LocalControlResponse;
  afterReply?: () => void | Promise<void>;
}

export type LocalControlHandler = (request: LocalControlRequest) => Promise<LocalControlDispatch>;

export interface LocalControlServerOptions {
  endpoint: string;
  handler: LocalControlHandler;
  maxLineBytes?: number;
  scheduleAfterReply?: (task: () => void) => void;
  onError?: (error: Error) => void;
}

export class LocalControlServer {
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private listening = false;
  private ownsEndpoint = false;

  constructor(private readonly options: LocalControlServerOptions) {
    this.server = createServer((socket) => this.accept(socket));
  }

  async listen(): Promise<void> {
    const releaseStartupLock = await acquireEndpointStartupLock(this.options.endpoint);
    try {
      await prepareEndpoint(this.options.endpoint);
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        this.server.once('error', onError);
        const listenTarget = isWindowsNamedPipe(this.options.endpoint)
          ? { path: this.options.endpoint, readableAll: false, writableAll: false }
          : this.options.endpoint;
        this.server.listen(listenTarget, () => {
          this.server.off('error', onError);
          this.server.on('error', (error) => this.report(error));
          this.listening = true;
          this.ownsEndpoint = true;
          resolve();
        });
      });
      if (!isWindowsNamedPipe(this.options.endpoint)) await chmod(this.options.endpoint, 0o600);
    } finally {
      try {
        await releaseStartupLock();
      } catch (error) {
        this.report(asError(error));
      }
    }
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    if (this.listening) {
      await new Promise<void>((resolve, reject) => {
        this.server.close((error) => error ? reject(error) : resolve());
      });
      this.listening = false;
    }
    if (this.ownsEndpoint) {
      await removeUnixSocket(this.options.endpoint);
      this.ownsEndpoint = false;
    }
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    socket.setEncoding('utf8');
    socket.setNoDelay(true);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', (error) => this.report(error));

    const framer = new NewlineJsonFramer(this.options.maxLineBytes ?? LOCAL_CONTROL_MAX_LINE_BYTES);
    let processing = Promise.resolve();
    socket.on('data', (chunk: string) => {
      try {
        for (const line of framer.push(chunk)) {
          processing = processing.then(() => this.processLine(socket, line));
        }
      } catch (error) {
        const frameError = error instanceof Error ? error : new Error(String(error));
        this.write(socket, {
          response: failedResponse('invalid', 'FRAME_TOO_LARGE', frameError.message),
        });
        socket.end();
      }
    });
    socket.on('end', () => {
      void processing.catch((error: unknown) => this.report(asError(error)));
    });
  }

  private async processLine(socket: Socket, line: string): Promise<void> {
    let requestValue: unknown;
    try {
      requestValue = JSON.parse(line);
    } catch {
      this.write(socket, { response: failedResponse('invalid', 'INVALID_JSON', 'request is not valid JSON') });
      return;
    }

    const parsed = LocalControlRequestSchema.safeParse(requestValue);
    if (!parsed.success) {
      const operationId = readOperationId(requestValue);
      this.write(socket, {
        response: failedResponse(operationId, 'INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'invalid request'),
      });
      return;
    }

    try {
      this.write(socket, await this.options.handler(parsed.data));
    } catch (error) {
      const handlerError = asError(error);
      this.report(handlerError);
      this.write(socket, {
        response: failedResponse(parsed.data.operation_id, 'INTERNAL_ERROR', handlerError.message),
      });
    }
  }

  private write(socket: Socket, dispatch: LocalControlDispatch): void {
    const frame = `${JSON.stringify(dispatch.response)}\n`;
    socket.write(frame, 'utf8', () => {
      if (!dispatch.afterReply) return;
      const invoke = (): void => {
        try {
          const pending = dispatch.afterReply?.();
          if (pending) void pending.catch((error: unknown) => this.report(asError(error)));
        } catch (error) {
          this.report(asError(error));
        }
      };
      const schedule = this.options.scheduleAfterReply ?? defaultAfterReplyScheduler;
      schedule(invoke);
    });
  }

  private report(error: Error): void {
    this.options.onError?.(error);
  }
}

const ENDPOINT_STARTUP_LOCK_WAIT_MS = 5_000;
const ENDPOINT_STARTUP_LOCK_STALE_MS = 30_000;

/**
 * Serialize stale-socket probing, unlink, and bind. mkdir is the atomic owner
 * election; stale owners are first renamed to a unique quarantine path so two
 * recovery attempts can never delete a newly acquired lock.
 */
async function acquireEndpointStartupLock(endpoint: string): Promise<() => Promise<void>> {
  if (isWindowsNamedPipe(endpoint)) return async () => undefined;
  await mkdir(dirname(endpoint), { recursive: true, mode: 0o700 });
  const lockPath = `${endpoint}.startup-lock`;
  const ownerPath = join(lockPath, 'owner.json');
  const deadline = Date.now() + ENDPOINT_STARTUP_LOCK_WAIT_MS;

  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      const ownerToken = randomUUID();
      try {
        await writeFile(ownerPath, JSON.stringify({ pid: process.pid, token: ownerToken }), {
          encoding: 'utf8',
          flag: 'wx',
          mode: 0o600,
        });
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      return async () => {
        try {
          const owner = JSON.parse(await readFile(ownerPath, 'utf8')) as { token?: unknown };
          if (owner.token === ownerToken) await rm(lockPath, { recursive: true, force: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    const lock = await readStartupLock(lockPath, ownerPath);
    if (!lock.exists) continue;
    const ownerAlive = lock.pid !== null && pidIsAlive(lock.pid);
    const stale = Date.now() - lock.mtimeMs >= ENDPOINT_STARTUP_LOCK_STALE_MS;
    if (!ownerAlive && (lock.pid !== null || stale)) {
      const quarantine = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
      try {
        await rename(lockPath, quarantine);
        await rm(quarantine, { recursive: true, force: true });
        continue;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'EEXIST') continue;
        throw error;
      }
    }
    if (Date.now() >= deadline) {
      const error = new Error(`local-control endpoint startup is already in progress: ${endpoint}`) as NodeJS.ErrnoException;
      error.code = 'EADDRINUSE';
      throw error;
    }
    await delay(25);
  }
}

async function readStartupLock(
  lockPath: string,
  ownerPath: string,
): Promise<{ exists: boolean; mtimeMs: number; pid: number | null }> {
  try {
    const info = await stat(lockPath);
    let pid: number | null = null;
    try {
      const parsed = JSON.parse(await readFile(ownerPath, 'utf8')) as { pid?: unknown };
      if (typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0) pid = parsed.pid;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    return { exists: true, mtimeMs: info.mtimeMs, pid };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, mtimeMs: 0, pid: null };
    throw error;
  }
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function prepareEndpoint(endpoint: string): Promise<void> {
  if (isWindowsNamedPipe(endpoint)) return;
  await mkdir(dirname(endpoint), { recursive: true, mode: 0o700 });
  try {
    await access(endpoint);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (await endpointAcceptsConnections(endpoint)) {
    const error = new Error(`local-control endpoint is already active: ${endpoint}`) as NodeJS.ErrnoException;
    error.code = 'EADDRINUSE';
    throw error;
  }
  await removeUnixSocket(endpoint);
}

function endpointAcceptsConnections(endpoint: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const socket = createConnection(endpoint);
    let settled = false;
    const finish = (active: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(active);
    };
    const timer = setTimeout(() => finish(true), 250);
    socket.once('connect', () => finish(true));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') finish(false);
      else if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
  });
}

async function removeUnixSocket(endpoint: string): Promise<void> {
  if (isWindowsNamedPipe(endpoint)) return;
  try {
    await unlink(endpoint);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function defaultAfterReplyScheduler(task: () => void): void {
  const timer = setTimeout(task, 25);
  timer.unref?.();
}

function readOperationId(value: unknown): string {
  if (typeof value !== 'object' || value === null) return 'invalid';
  const operationId = (value as Record<string, unknown>).operation_id;
  return typeof operationId === 'string' && operationId.length > 0 ? operationId : 'invalid';
}

function asError(error: unknown): Error {
  if (error instanceof LineTooLongError) return error;
  return error instanceof Error ? error : new Error(String(error));
}
