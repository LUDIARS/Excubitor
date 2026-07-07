import { writeDiagnostic } from './shared/diagnostic-log.js';
import { runStartupNpmInstallAndAudit } from './startup/npm-install.js';

const port = Number(process.env.EXCUBITOR_PORT ?? 17332);

type Logger = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

type CloseableServer = {
  close: () => void;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  ref?: () => void;
  requestTimeout?: number;
  headersTimeout?: number;
  keepAliveTimeout?: number;
};

type SocketLike = {
  on: (event: string, listener: () => void) => void;
};

const fallbackLogger: Logger = {
  info: (...args) => console.info('[excubitor.server]', ...args),
  warn: (...args) => console.warn('[excubitor.server]', ...args),
  error: (...args) => console.error('[excubitor.server]', ...args),
};

let logger: Logger = fallbackLogger;
let shutdown: (() => Promise<void>) | null = null;
let closeDbFn: (() => void) | null = null;
let stopping = false;
let activeServer: CloseableServer | null = null;
let connectionLogTimer: NodeJS.Timeout | null = null;
const activeSockets = new Set<SocketLike>();
const processStartedAt = Date.now();
const requestTimeoutMs = readPositiveIntEnv('EXCUBITOR_BACKEND_REQUEST_TIMEOUT_MS', 95_000);
const headersTimeoutMs = readPositiveIntEnv('EXCUBITOR_BACKEND_HEADERS_TIMEOUT_MS', 65_000);
const keepAliveTimeoutMs = readPositiveIntEnv('EXCUBITOR_BACKEND_KEEP_ALIVE_TIMEOUT_MS', 5_000);

process.on('uncaughtException', (err) => {
  logger.error({ err: err.stack ?? err.message }, 'uncaught exception');
  writeDiagnostic('uncaughtException', { err: err.stack ?? err.message });
});

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
  logger.error(
    { err },
    'unhandled rejection',
  );
  writeDiagnostic('unhandledRejection', { err });
});

process.on('beforeExit', (code) => {
  logger.warn({ code }, 'process beforeExit');
  writeDiagnostic('process.beforeExit', { code });
});

process.on('exit', (code) => {
  writeDiagnostic('process.exit', { code });
});

try {
  const startupNpmStartedAt = Date.now();
  const startupNpm = await runStartupNpmInstallAndAudit(process.cwd());
  writeDiagnostic('server.startup.npm.complete', {
    duration_ms: Date.now() - startupNpmStartedAt,
    install_ok: startupNpm.installOk,
    audit_ok: startupNpm.auditOk,
    issues: startupNpm.issues.length,
    skipped: startupNpm.skipped === true,
  });
  const [
    serverModule,
    observabilityModule,
    dbModule,
    loggerModule,
  ] = await Promise.all([
    import('@hono/node-server'),
    import('./index.js'),
    import('./db/index.js'),
    import('./shared/logger.js'),
  ]);
  const { serve } = serverModule;
  const { bootObservability, recordStartupNpmIssues } = observabilityModule;
  const { openDb, closeDb } = dbModule;
  const { createNamedLogger } = loggerModule;
  closeDbFn = closeDb;
  logger = createNamedLogger('excubitor.server');

  logger.info({ port, argv: process.argv.slice(2), cwd: process.cwd() }, 'starting Excubitor server');
  writeDiagnostic('server.starting', { port, argv: process.argv.slice(2), cwd: process.cwd() });
  openDb('data/excubitor.sqlite');
  writeDiagnostic('server.db.opened');
  recordStartupNpmIssues(startupNpm.issues);

  const booted = await bootObservability();
  shutdown = booted.shutdown;
  writeDiagnostic('server.boot.complete', { duration_ms: Date.now() - processStartedAt });
  booted.router.onError((err, c) => {
    logger.error(
      { err: err.stack ?? err.message, method: c.req.method, path: c.req.path },
      'request failed',
    );
    writeDiagnostic('server.request.failed', {
      err: err.stack ?? err.message,
      method: c.req.method,
      path: c.req.path,
    });
    return c.json({ error: 'internal_server_error', message: err.message }, 500);
  });

  const server = serve({ fetch: booted.router.fetch, port, hostname: '127.0.0.1' }) as CloseableServer;
  activeServer = server;
  server.ref?.();
  server.requestTimeout = requestTimeoutMs;
  server.headersTimeout = headersTimeoutMs;
  server.keepAliveTimeout = keepAliveTimeoutMs;
  server.on('connection', (socket: unknown) => {
    const tracked = socket as SocketLike;
    activeSockets.add(tracked);
    tracked.on('close', () => activeSockets.delete(tracked));
  });
  connectionLogTimer = setInterval(() => {
    const payload = {
      active_sockets: activeSockets.size,
      request_timeout_ms: requestTimeoutMs,
      headers_timeout_ms: headersTimeoutMs,
      keep_alive_timeout_ms: keepAliveTimeoutMs,
    };
    logger.info(payload, 'backend connection summary');
    if (activeSockets.size >= 50) writeDiagnostic('server.connections.high', payload);
  }, 30_000);
  connectionLogTimer.unref?.();
  server.on('listening', () => {
    logger.info({ port, requestTimeoutMs, headersTimeoutMs, keepAliveTimeoutMs }, 'Excubitor server listening');
    writeDiagnostic('server.listening', { port, requestTimeoutMs, headersTimeoutMs, keepAliveTimeoutMs });
  });
  server.on('error', (err) => {
    const error = err instanceof Error ? err.stack ?? err.message : String(err);
    const code = (err as NodeJS.ErrnoException).code ?? null;
    logger.error({ err: error, code, port }, 'Excubitor server listen error');
    writeDiagnostic('server.listen.error', { err: error, code, port });
    if (code === 'EADDRINUSE') {
      void shutdownAndExit(1, 'listen address already in use');
    }
  });
  server.on('close', () => {
    logger.warn({ port }, 'Excubitor server closed');
    writeDiagnostic('server.closed', { port });
  });
} catch (err) {
  const error = err instanceof Error ? err.stack ?? err.message : String(err);
  logger.error({ err: error }, 'Excubitor boot failed');
  writeDiagnostic('server.boot.failed', { err: error });
  try { closeDbFn?.(); } catch { /* noop */ }
  process.exitCode = 1;
}

async function shutdownAndExit(exitCode: number, reason: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ reason, exitCode }, 'stopping Excubitor server');
  writeDiagnostic('server.stopping', { reason, exitCode });
  await shutdown?.();
  activeServer?.close();
  if (connectionLogTimer) clearInterval(connectionLogTimer);
  activeSockets.clear();
  try { closeDbFn?.(); } catch (err) {
    logger.warn({ err: (err as Error).message }, 'closeDb failed');
  }
  process.exit(exitCode);
}

const stop = async () => shutdownAndExit(0, 'signal');

process.on('SIGINT', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });

function readPositiveIntEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
