import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import type { Socket } from 'node:net';
import { resolve } from 'node:path';
import { accessSync } from 'node:fs';
import { buildDmzRouter } from './dmz-router.js';
import { readViewerDirectory } from './read-directory.js';
import { installViewerWebSockets } from './websocket.js';

// The supervisor derives this variable from the owned catalog, without a fallback.
const port = Number(process.env.EXCUBITOR_VIEWER_DMZ_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Catalog DMZ port is required');
accessSync(resolve('frontend/dist-dmz/index.html'));
const directory = readViewerDirectory(resolve('data/viewer-manifest.json'));
const app = buildDmzRouter(directory);
const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }) as Server;
const closeUpgrades = installViewerWebSockets(server, (code) => directory.target(code));
const sockets = new Set<Socket>();
server.on('connection', (socket) => {
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
});
server.requestTimeout = 95_000;
server.headersTimeout = 65_000;
server.keepAliveTimeout = 5_000;
let stopping = false;
function stop(): void {
  if (stopping) return;
  stopping = true;
  closeUpgrades();
  server.close();
  for (const socket of sockets) socket.destroy();
  sockets.clear();
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
