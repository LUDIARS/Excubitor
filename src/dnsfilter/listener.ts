/** @implements SPEC-EX-DNS-FILTER */
/**
 * 1 つのアドレスで UDP と TCP の DNS を待ち受け、 問い合わせを resolver へ渡す。
 * TCP は 2 バイトの長さ + メッセージの並び (RFC 1035 4.2.2、 RFC 7766)。 応答は終わった順に返す。
 */

import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { createServer, type Server, type Socket } from 'node:net';
import { formatEndpoint, type Endpoint } from './endpoint.js';
import type { ClientInfo } from './resolver.js';

export type QueryHandler = (packet: Buffer, client: ClientInfo) => Promise<Buffer | null>;

/** TCP の同時接続の上限。 */
const MAX_TCP_CONNECTIONS = 64;
/** TCP で何も来ない接続を閉じるまでの時間。 */
const TCP_IDLE_MS = 10_000;
/** 1 接続でためる受信の上限 (長さ 2 バイト + 最大メッセージ)。 */
const MAX_TCP_BUFFER = 2 + 65_535;

export interface ListenerLog {
  (level: 'info' | 'warn', message: string, detail: Record<string, unknown>): void;
}

export class DnsListener {
  private udp: UdpSocket | null = null;
  private tcp: Server | null = null;
  private readonly connections = new Set<Socket>();

  constructor(
    readonly endpoint: Endpoint,
    private readonly handle: QueryHandler,
    private readonly log: ListenerLog,
  ) {}

  /** 両方を開く。 片方でも開けなければ両方閉じて失敗を返す。 */
  async start(): Promise<void> {
    try {
      await this.startUdp();
      await this.startTcp();
    } catch (error) {
      await this.stop();
      throw new Error(`${formatEndpoint(this.endpoint)} で待ち受けられない: ${(error as Error).message}`);
    }
  }

  async stop(): Promise<void> {
    for (const connection of this.connections) connection.destroy();
    this.connections.clear();
    const udp = this.udp;
    const tcp = this.tcp;
    this.udp = null;
    this.tcp = null;
    if (udp) await new Promise<void>((done) => { try { udp.close(() => done()); } catch { done(); } });
    if (tcp) await new Promise<void>((done) => tcp.close(() => done()));
  }

  private startUdp(): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      const socket = createSocket({ type: this.endpoint.family === 6 ? 'udp6' : 'udp4', ipv6Only: this.endpoint.family === 6 });
      this.udp = socket;
      const onBindError = (error: Error): void => reject(error);
      socket.once('error', onBindError);
      socket.on('message', (packet, remote) => {
        void this.handle(packet, { address: remote.address, transport: 'udp' }).then((response) => {
          if (response && this.udp === socket) socket.send(response, remote.port, remote.address);
        }).catch((error: unknown) => {
          this.log('warn', 'dns-filter: udp query failed', { err: (error as Error).message });
        });
      });
      socket.bind(this.endpoint.port, this.endpoint.host, () => {
        socket.off('error', onBindError);
        socket.on('error', (error) => this.log('warn', 'dns-filter: udp socket error', { err: error.message }));
        resolvePromise();
      });
    });
  }

  private startTcp(): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      const server = createServer((connection) => this.accept(connection));
      this.tcp = server;
      server.maxConnections = MAX_TCP_CONNECTIONS;
      const onListenError = (error: Error): void => reject(error);
      server.once('error', onListenError);
      server.listen({ port: this.endpoint.port, host: this.endpoint.host, ipv6Only: this.endpoint.family === 6 }, () => {
        server.off('error', onListenError);
        server.on('error', (error) => this.log('warn', 'dns-filter: tcp server error', { err: error.message }));
        resolvePromise();
      });
    });
  }

  private accept(connection: Socket): void {
    this.connections.add(connection);
    connection.setTimeout(TCP_IDLE_MS, () => connection.destroy());
    connection.on('close', () => this.connections.delete(connection));
    connection.on('error', () => connection.destroy());
    const address = connection.remoteAddress ?? '';
    let buffered = Buffer.alloc(0);
    connection.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > MAX_TCP_BUFFER * 2) {
        connection.destroy();
        return;
      }
      while (buffered.length >= 2) {
        const size = buffered.readUInt16BE(0);
        if (buffered.length < 2 + size) break;
        const packet = buffered.subarray(2, 2 + size);
        buffered = buffered.subarray(2 + size);
        void this.handle(packet, { address, transport: 'tcp' }).then((response) => {
          if (!response) {
            connection.destroy();
            return;
          }
          if (connection.destroyed) return;
          const length = Buffer.alloc(2);
          length.writeUInt16BE(response.length, 0);
          connection.write(Buffer.concat([length, response]));
        }).catch((error: unknown) => {
          this.log('warn', 'dns-filter: tcp query failed', { err: (error as Error).message });
          connection.destroy();
        });
      }
    });
  }
}
