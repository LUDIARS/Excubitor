import { createServer, request, type Server } from 'node:http';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { describe, it, expect, vi } from 'vitest';
import { startIntrusionGateway } from './gateway.js';
import { IntrusionMonitor } from './monitor.js';
import { config } from './test-fixtures.js';

async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('port expected');
  return address.port;
}

describe('loopback gateway', () => {
  it('forwards only configured domestic requests and closes an existing upgraded connection on an incident', async () => {
    const origin = createServer((incoming, response) => response.end(incoming.headers.host));
    const originSockets = new Set<Duplex>();
    let upgradeHost: string | undefined;
    origin.on('upgrade', (incoming, socket) => {
      upgradeHost = incoming.headers.host;
      originSockets.add(socket);
      socket.once('close', () => originSockets.delete(socket));
      socket.on('error', () => socket.destroy());
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    });
    const originPort = await listen(origin);
    // Reserve a free test-only port; production always takes it from the catalog.
    const reservation = createServer();
    const port = await listen(reservation);
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const localConfig = { ...config, routes: [{ ...config.routes[0]!, origin: `http://127.0.0.1:${originPort}`,
      routeKey: 'r-test.intrusion.invalid', path: '^/', forwardHost: 'original.internal' }] };
    let gateway: Awaited<ReturnType<typeof startIntrusionGateway>> | null = null;
    const monitor = new IntrusionMonitor(localConfig, { load: () => null, save: vi.fn(), evidence: vi.fn(),
      contain: vi.fn().mockResolvedValue(undefined), notify: vi.fn().mockResolvedValue(undefined),
      closePublicConnections: () => gateway?.closeConnections(), now: Date.now, warn: vi.fn() });
    const openSockets: ReturnType<typeof connect>[] = [];
    try {
      gateway = await startIntrusionGateway(localConfig, port, monitor);
      const response = await new Promise<string>((resolve, reject) => {
        const req = request(`http://127.0.0.1:${port}`, { headers: { host: 'r-test.intrusion.invalid', 'cf-ipcountry': 'JP', 'cf-connecting-ip': '203.0.113.1' } }, res => {
          let body = ''; res.on('data', chunk => { body += String(chunk); }); res.on('end', () => resolve(body));
        }); req.on('error', reject); req.end();
      });
      expect(response).toBe('original.internal');
      const socket = connect(port, '127.0.0.1');
      openSockets.push(socket);
      socket.on('error', () => socket.destroy());
      const upgraded = new Promise<void>(resolve => socket.once('data', () => resolve()));
      socket.write('GET /ws HTTP/1.1\r\nHost: r-test.intrusion.invalid\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nCF-IPCountry: JP\r\nCF-Connecting-IP: 203.0.113.1\r\n\r\n');
      await upgraded;
      expect(upgradeHost).toBe('original.internal');
      const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));
      monitor.trip({ service: 'app', at: Date.now() }, 'foreign_country');
      await closed;
      expect(monitor.status().state).toBe('blocked');
    } finally {
      for (const socket of openSockets) socket.destroy();
      await gateway?.close();
      await monitor.stop();
      for (const socket of originSockets) socket.destroy();
      await new Promise<void>(resolve => origin.close(() => resolve()));
    }
  });
});
