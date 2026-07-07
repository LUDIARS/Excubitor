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
  const startupNpm = await runStartupNpmInstallAndAudit(process.cwd());
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
  writeDiagnostic('server.boot.complete');
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
  server.on('listening', () => {
    logger.info({ port }, 'Excubitor server listening');
    writeDiagnostic('server.listening', { port });
  });
  server.on('error', (err) => {
    const error = err instanceof Error ? err.stack ?? err.message : String(err);
    logger.error({ err: error, port }, 'Excubitor server listen error');
    writeDiagnostic('server.listen.error', { err: error, port });
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

const stop = async () => {
  if (stopping) return;
  stopping = true;
  logger.info('stopping Excubitor server');
  writeDiagnostic('server.stopping');
  await shutdown?.();
  activeServer?.close();
  try { closeDbFn?.(); } catch (err) {
    logger.warn({ err: (err as Error).message }, 'closeDb failed');
  }
  process.exit(0);
};

process.on('SIGINT', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });
