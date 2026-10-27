import { request, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

/** Preserve streaming/backpressure; target is an operator-validated loopback origin. */
export function proxyHttp(incoming: IncomingMessage, response: ServerResponse, origin: string,
  onStatus: (status: number) => void): void {
  const upstream = request(origin, { method: incoming.method, path: incoming.url,
    headers: { ...incoming.headers, connection: 'close' } });
  const close = (): void => { upstream.destroy(); };
  response.once('close', close);
  incoming.once('aborted', close);
  incoming.once('error', close);
  upstream.setTimeout(60_000, () => upstream.destroy());
  upstream.once('error', () => {
    if (!response.headersSent) response.writeHead(502, { 'cache-control': 'no-store' });
    response.end();
  });
  upstream.once('response', peer => {
    onStatus(peer.statusCode ?? 502);
    if (response.destroyed) { peer.destroy(); return; }
    response.writeHead(peer.statusCode ?? 502, peer.headers);
    peer.once('error', () => response.destroy());
    peer.pipe(response);
  });
  incoming.pipe(upstream);
}

export function proxyUpgrade(incoming: IncomingMessage, socket: Duplex, head: Buffer, origin: string,
  onStatus: (status: number) => void): void {
  const upstream = request(origin, { method: 'GET', path: incoming.url, headers: incoming.headers });
  let peer: Duplex | null = null;
  const close = (): void => { upstream.destroy(); peer?.destroy(); socket.destroy(); };
  socket.once('error', close);
  socket.once('close', close);
  upstream.once('error', close);
  upstream.setTimeout(15_000, close);
  upstream.once('response', response => { onStatus(response.statusCode ?? 502); response.resume(); close(); });
  upstream.once('upgrade', (response, remote, remoteHead) => {
    peer = remote;
    onStatus(101);
    if (socket.destroyed) { close(); return; }
    upstream.setTimeout(0);
    remote.once('error', close);
    remote.once('close', close);
    const headers = ['HTTP/1.1 101 Switching Protocols', 'Connection: Upgrade', 'Upgrade: websocket'];
    for (const name of ['sec-websocket-accept', 'sec-websocket-protocol', 'sec-websocket-extensions']) {
      const value = response.headers[name];
      if (typeof value === 'string') headers.push(`${name}: ${value}`);
    }
    socket.write(headers.join('\r\n') + '\r\n\r\n');
    if (head.length) remote.write(head);
    if (remoteHead.length) socket.write(remoteHead);
    remote.pipe(socket);
    socket.pipe(remote);
  });
  upstream.end();
}
