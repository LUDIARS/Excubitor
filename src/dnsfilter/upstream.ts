/** @implements SPEC-EX-DNS-FILTER */
/**
 * 上流の DNS へ問い合わせをそのまま渡し、 応答を受け取る。 UDP は問い合わせごとに新しい
 * ソケット (送信元ポートが毎回変わり、 ID の衝突も起きない)、 TCP は 1 問い合わせ 1 接続。
 * 待ち時間を過ぎたら失敗にする (別の上流は試さない)。
 */

import { createSocket } from 'node:dgram';
import { connect } from 'node:net';
import type { Endpoint } from './endpoint.js';

/** UDP で受ける応答の上限 (EDNS の大きな応答も入る)。 */
const MAX_UDP_RESPONSE = 65_535;

export type Transport = 'udp' | 'tcp';
export type Forwarder = (query: Buffer, transport: Transport) => Promise<Buffer>;

export function forwardUdp(query: Buffer, upstream: Endpoint, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const socket = createSocket(upstream.family === 6 ? 'udp6' : 'udp4');
    const id = query.readUInt16BE(0);
    let settled = false;
    const finish = (error: Error | null, response?: Buffer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolvePromise(response!);
    };
    const timer = setTimeout(() => finish(new Error(`上流 ${upstream.host} が ${timeoutMs}ms 応答しない`)), timeoutMs);
    socket.on('error', (error) => finish(error));
    socket.on('message', (message, remote) => {
      // 上流以外から届いたもの・ID が違うものは捨てて待ち続ける (偽の応答を混ぜない)。
      if (remote.address.toLowerCase() !== upstream.host || remote.port !== upstream.port) return;
      if (message.length < 2 || message.length > MAX_UDP_RESPONSE || message.readUInt16BE(0) !== id) return;
      finish(null, message);
    });
    socket.send(query, upstream.port, upstream.host, (error) => {
      if (error) finish(error);
    });
  });
}

export function forwardTcp(query: Buffer, upstream: Endpoint, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const socket = connect({ host: upstream.host, port: upstream.port });
    let received = Buffer.alloc(0);
    let settled = false;
    const finish = (error: Error | null, response?: Buffer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolvePromise(response!);
    };
    const timer = setTimeout(() => finish(new Error(`上流 ${upstream.host} が ${timeoutMs}ms 応答しない`)), timeoutMs);
    socket.on('error', (error) => finish(error));
    socket.on('close', () => finish(new Error('上流が応答の前に接続を閉じた')));
    socket.on('connect', () => {
      const length = Buffer.alloc(2);
      length.writeUInt16BE(query.length, 0);
      socket.write(Buffer.concat([length, query]));
    });
    socket.on('data', (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (received.length < 2) return;
      const size = received.readUInt16BE(0);
      if (received.length >= 2 + size) finish(null, received.subarray(2, 2 + size));
    });
  });
}

/** 上流 1 つへの中継。 受けた経路 (UDP / TCP) と同じ経路で渡す。 */
export function createForwarder(upstream: Endpoint, timeoutMs: number): Forwarder {
  return (query, transport) => transport === 'udp'
    ? forwardUdp(query, upstream, timeoutMs)
    : forwardTcp(query, upstream, timeoutMs);
}
