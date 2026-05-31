import { serve } from '@hono/node-server';
import { bootObservability } from './index.js';
import { openDb, closeDb } from './db/index.js';

const port = Number(process.env.EXCUBITOR_PORT ?? 17332);
openDb('data/excubitor.sqlite');

const { router, shutdown } = await bootObservability();
serve({ fetch: router.fetch, port, hostname: '127.0.0.1' });

const stop = async () => {
  await shutdown();
  closeDb();
  process.exit(0);
};

process.on('SIGINT', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });


