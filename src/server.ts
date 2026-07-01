import { serve } from '@hono/node-server';
import { bootObservability } from './index.js';
import { openDb, closeDb } from './db/index.js';
import { createNamedLogger } from './shared/logger.js';
import { writeDiagnostic } from './shared/diagnostic-log.js';

const port = Number(process.env.EXCUBITOR_PORT ?? 17332);
const logger = createNamedLogger('excubitor.server');
let shutdown: (() => Promise<void>) | null = null;
let stopping = false;
let activeServer: ReturnType<typeof serve> | null = null;

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
  logger.info({ port, argv: process.argv.slice(2), cwd: process.cwd() }, 'starting Excubitor server');
  writeDiagnostic('server.starting', { port, argv: process.argv.slice(2), cwd: process.cwd() });
  openDb('data/excubitor.sqlite');
  writeDiagnostic('server.db.opened');

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

  const server = serve({ fetch: booted.router.fetch, port, hostname: '127.0.0.1' });
  activeServer = server;
  server.on('listening', () => {
    logger.info({ port }, 'Excubitor server listening');
    writeDiagnostic('server.listening', { port });
  });
  server.on('error', (err) => {
    logger.error({ err: err.stack ?? err.message, port }, 'Excubitor server listen error');
    writeDiagnostic('server.listen.error', { err: err.stack ?? err.message, port });
  });
  server.on('close', () => {
    logger.warn({ port }, 'Excubitor server closed');
    writeDiagnostic('server.closed', { port });
  });
} catch (err) {
  logger.error({ err: err instanceof Error ? err.stack ?? err.message : String(err) }, 'Excubitor boot failed');
  writeDiagnostic('server.boot.failed', { err: err instanceof Error ? err.stack ?? err.message : String(err) });
  try { closeDb(); } catch { /* noop */ }
  process.exitCode = 1;
}

const stop = async () => {
  if (stopping) return;
  stopping = true;
  logger.info('stopping Excubitor server');
  writeDiagnostic('server.stopping');
  await shutdown?.();
  activeServer?.close();
  try { closeDb(); } catch (err) {
    logger.warn({ err: (err as Error).message }, 'closeDb failed');
  }
  process.exit(0);
};

process.on('SIGINT', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });


