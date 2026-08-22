/**
 * Docker Engine API の最小 HTTP クライアント (GET JSON のみ)。
 *
 * 子プロセスを spawn しない。 named pipe / unix socket は `http.request({ socketPath })`、
 * TCP は host/port で接続する。 タイムアウト時はソケットを破棄して reject し、
 * 呼び出し側 (scanner / memory sampler) が null / 例外として扱う。
 */

import http from 'node:http';

import { engineEndpoint, type EngineEndpoint } from './engine-endpoint.js';

/** Engine API のバージョン prefix。 v1.41 = Docker 20.10 以降で安定。 */
const API_PREFIX = '/v1.41';

export class DockerEngineError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'DockerEngineError';
  }
}

export function engineGetJson<T>(path: string, timeoutMs: number, endpoint: EngineEndpoint = engineEndpoint()): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const options: http.RequestOptions =
      endpoint.kind === 'tcp'
        ? { host: endpoint.host, port: endpoint.port, path: `${API_PREFIX}${path}`, method: 'GET' }
        : { socketPath: endpoint.socketPath, path: `${API_PREFIX}${path}`, method: 'GET' };
    // Host ヘッダは Engine が要求する (socket 経由でも必須)。
    options.headers = { Host: 'docker', Connection: 'close' };

    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };

    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          finish(() => reject(new DockerEngineError(`GET ${path} → ${status}: ${body.slice(0, 200)}`, status)));
          return;
        }
        let parsed: T;
        try {
          parsed = JSON.parse(body) as T;
        } catch (err) {
          finish(() => reject(new DockerEngineError(`GET ${path}: invalid JSON (${(err as Error).message})`, status)));
          return;
        }
        finish(() => resolve(parsed));
      });
      res.on('error', (err) => finish(() => reject(err)));
    });
    // req.setTimeout は socket 接続後にしか作動しない。 Rancher backend 不調で connect 自体が
    // 返らないケースを取り逃がすため、 全体予算を独立タイマで持ち destroy → error で決着させる。
    timer = setTimeout(() => {
      req.destroy(new DockerEngineError(`GET ${path} timed out after ${timeoutMs}ms`, null));
    }, timeoutMs);
    timer.unref?.();
    req.on('error', (err) => finish(() => reject(err)));
    // destroy 後も 'error' が出ない経路 (応答受信中の abort 等) があるため close でも決着させる。
    req.on('close', () => finish(() => reject(new DockerEngineError(`GET ${path} closed before completion`, null))));
    req.end();
  });
}
