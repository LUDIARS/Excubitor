import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { engineGetJson, DockerEngineError } from './engine-client.js';
import type { EngineEndpoint } from './engine-endpoint.js';

const servers: http.Server[] = [];

/** テスト用の Engine API スタブを loopback に立て、 tcp endpoint を返す。 */
async function stubEngine(handler: http.RequestListener): Promise<EngineEndpoint> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return { kind: 'tcp', host: '127.0.0.1', port: address.port };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

describe('engineGetJson', () => {
  it('2xx の JSON body を parse して返し、 API prefix を付ける', async () => {
    let seenPath: string | undefined;
    const endpoint = await stubEngine((req, res) => {
      seenPath = req.url;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ Id: 'abc' }]));
    });
    const rows = await engineGetJson<Array<{ Id: string }>>('/containers/json?all=1', 5_000, endpoint);
    expect(rows).toEqual([{ Id: 'abc' }]);
    expect(seenPath).toBe('/v1.41/containers/json?all=1');
  });

  it('非 2xx は status 付きの DockerEngineError', async () => {
    const endpoint = await stubEngine((_req, res) => {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"message":"no such container"}');
    });
    await expect(engineGetJson('/containers/x/stats', 5_000, endpoint)).rejects.toMatchObject({
      name: 'DockerEngineError',
      status: 404,
    });
  });

  it('壊れた JSON は invalid JSON として reject', async () => {
    const endpoint = await stubEngine((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('not-json');
    });
    await expect(engineGetJson('/containers/json', 5_000, endpoint)).rejects.toThrow(/invalid JSON/);
  });

  // 応答を返さない daemon で promise が宙吊りにならないこと。 これが漏れると scanner tick が
  // 永久に完了せず死活監視が沈黙停止する (旧 docker CLI ハング事故と同じ失敗形)。
  it('応答しない相手はタイムアウトで reject する', async () => {
    const endpoint = await stubEngine(() => {
      /* 意図的に応答しない */
    });
    const err = await engineGetJson('/containers/json', 150, endpoint).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DockerEngineError);
    expect((err as Error).message).toMatch(/timed out/);
  });

  it('接続不能な endpoint は reject する (ハングしない)', async () => {
    const endpoint = await stubEngine((_req, res) => res.end('{}'));
    const closed = servers.splice(0)[0]!;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    await expect(engineGetJson('/containers/json', 2_000, endpoint)).rejects.toBeDefined();
  });
});
