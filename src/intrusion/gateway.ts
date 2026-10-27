import { createServer, type IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type { IntrusionConfig } from './config.js';
import type { AccessEvidence } from './detection.js';
import type { IntrusionMonitor } from './monitor.js';
import { proxyHttp, proxyUpgrade } from './proxy.js';

/** A separate loopback listener; it never mounts the management router. */
export async function startIntrusionGateway(config: IntrusionConfig, port: number,
  monitor: IntrusionMonitor, now: () => number = Date.now): Promise<{ closeConnections(): void; close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const routes = new Map(config.routes.map(route => [route.hostname, route]));
  const resolve = (request: IncomingMessage): { origin: string; evidence: AccessEvidence } | null => {
    // Host identity is exact. Absolute-form URLs and duplicate/ambiguous authority are rejected.
    const host = request.headers.host?.toLowerCase();
    const hostCount = request.rawHeaders.filter((_value, index) => index % 2 === 0 && request.rawHeaders[index]?.toLowerCase() === 'host').length;
    if (hostCount !== 1) return null;
    const route = host ? routes.get(host) : undefined;
    const raw = request.url ?? '';
    if (!route || !raw.startsWith('/') || raw.startsWith('//') || raw.length > 8192) return null;
    const country = request.headers['cf-ipcountry'];
    const ip = request.headers['cf-connecting-ip'];
    const evidence: AccessEvidence = { service: route.service, hostname: route.hostname,
      clientIp: typeof ip === 'string' ? ip : '', country: typeof country === 'string' ? country : '',
      path: raw.split('?')[0] ?? '/', method: request.method ?? 'GET', at: now() };
    return monitor.inspect(evidence) ? { origin: route.origin, evidence } : null;
  };
  const server = createServer((request, response) => {
    const target = resolve(request);
    if (!target) { response.writeHead(503, { 'cache-control': 'no-store', connection: 'close' }); response.end(); return; }
    proxyHttp(request, response, target.origin, status => monitor.response(target.evidence, status));
  });
  server.on('upgrade', (request, socket, head) => {
    const target = resolve(request);
    if (!target || request.headers.upgrade?.toLowerCase() !== 'websocket') { socket.destroy(); return; }
    proxyUpgrade(request, socket, head, target.origin, status => monitor.response(target.evidence, status));
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('clientError', (_error, socket) => socket.destroy());
  server.maxConnections = 1024;
  server.headersTimeout = 15_000;
  server.requestTimeout = 60_000;
  server.keepAliveTimeout = 5_000;
  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolveListen(); });
    });
  } catch (error) { server.close(); throw error; }
  const closeConnections = (): void => { for (const socket of sockets) socket.destroy(); };
  return { closeConnections, close: () => new Promise<void>((resolveClose, reject) => {
    server.close(error => error ? reject(error) : resolveClose());
    closeConnections();
  }) };
}
