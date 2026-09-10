import { request, type Server, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { ViewerTarget } from './catalog.js';
import { upstreamHeaders } from './headers.js';
import { upstreamRequestUrl } from './urls.js';

/** Own every upgraded connection until either peer disconnects or Ex shuts down. */
export function installViewerWebSockets(server: Server, resolveTarget: (code: string) => ViewerTarget | null): () => void {
  const sockets = new Set<Duplex>();
  const onUpgrade = (incoming: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const path = incoming.url ?? '';
    const match = /^\/viewer\/apps\/([a-zA-Z0-9_-]+)\//.exec(path);
    if (!match?.[1]) { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return; }
    let target: ViewerTarget | null;
    try { target = resolveTarget(match[1]); }
    catch { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return; }
    if (!target) { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return; }
    let url: URL;
    try { url = upstreamRequestUrl('http://viewer.invalid' + path, target); }
    catch { socket.destroy(); return; }
    const rawHeaders = new Headers();
    for (const [key, value] of Object.entries(incoming.headers)) {
      if (typeof value === 'string') rawHeaders.set(key, value);
      else if (Array.isArray(value)) rawHeaders.set(key, value.join(', '));
    }
    const headers = upstreamHeaders(rawHeaders, target);
    headers.set('connection', 'Upgrade');
    headers.set('upgrade', 'websocket');
    let peer: Duplex | null = null;
    const upstream = request(url, { headers: Object.fromEntries(headers) });
    const close = (): void => {
      upstream.destroy();
      peer?.destroy();
      socket.destroy();
      sockets.delete(socket);
      if (peer) sockets.delete(peer);
    };
    sockets.add(socket);
    socket.on('error', close);
    socket.on('close', close);
    upstream.on('error', close);
    upstream.setTimeout(15_000, close);
    upstream.on('response', (response) => { response.resume(); close(); });
    upstream.on('upgrade', (response, upstreamSocket, upstreamHead) => {
      peer = upstreamSocket;
      if (socket.destroyed) { close(); return; }
      upstream.setTimeout(0);
      sockets.add(peer);
      peer.on('error', close);
      peer.on('close', close);
      const handshake = ['HTTP/1.1 101 Switching Protocols', 'Connection: Upgrade', 'Upgrade: websocket'];
      for (const name of ['sec-websocket-accept', 'sec-websocket-protocol', 'sec-websocket-extensions']) {
        const value = response.headers[name];
        if (typeof value === 'string') handshake.push(`${name}: ${value}`);
      }
      socket.write(handshake.join('\r\n') + '\r\n\r\n');
      if (head.length) peer.write(head);
      if (upstreamHead.length) socket.write(upstreamHead);
      peer.pipe(socket);
      socket.pipe(peer);
    });
    upstream.end();
  };
  server.on('upgrade', onUpgrade);
  return () => {
    server.off('upgrade', onUpgrade);
    for (const socket of sockets) socket.destroy();
    sockets.clear();
  };
}
