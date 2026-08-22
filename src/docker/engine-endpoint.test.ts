import { describe, it, expect, afterEach } from 'vitest';
import {
  parseEngineHost,
  resolveEngineEndpoint,
  describeEndpoint,
  defaultEndpoint,
  DEFAULT_WINDOWS_PIPE,
  DEFAULT_UNIX_SOCKET,
} from './engine-endpoint.js';

describe('parseEngineHost', () => {
  it('空なら platform 既定', () => {
    expect(parseEngineHost('', 'win32')).toEqual({ kind: 'socket', socketPath: DEFAULT_WINDOWS_PIPE });
    expect(parseEngineHost(undefined, 'linux')).toEqual({ kind: 'socket', socketPath: DEFAULT_UNIX_SOCKET });
  });
  it('tcp:// はポート既定 2375', () => {
    expect(parseEngineHost('tcp://127.0.0.1:2375')).toEqual({ kind: 'tcp', host: '127.0.0.1', port: 2375 });
    expect(parseEngineHost('tcp://localhost')).toEqual({ kind: 'tcp', host: 'localhost', port: 2375 });
    expect(parseEngineHost('tcp://h:99999')).toBeNull();
  });
  it('npipe:// は docker CLI 表記を Windows パスへ', () => {
    expect(parseEngineHost('npipe:////./pipe/docker_engine')).toEqual({ kind: 'socket', socketPath: '\\\\.\\pipe\\docker_engine' });
  });
  it('unix:// はそのまま', () => {
    expect(parseEngineHost('unix:///var/run/docker.sock')).toEqual({ kind: 'socket', socketPath: '/var/run/docker.sock' });
  });
  it('不明スキームは null', () => {
    expect(parseEngineHost('ssh://x')).toBeNull();
  });
  it('IPv6 リテラルは bracket を外して host にする', () => {
    expect(parseEngineHost('tcp://[::1]:2375')).toEqual({ kind: 'tcp', host: '::1', port: 2375 });
  });
});

describe('resolveEngineEndpoint', () => {
  const originalDockerHost = process.env.DOCKER_HOST;
  afterEach(() => {
    if (originalDockerHost === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = originalDockerHost;
  });

  it('config が有効ならそれを使い invalid は出さない', () => {
    delete process.env.DOCKER_HOST;
    expect(resolveEngineEndpoint('tcp://127.0.0.1:2375')).toEqual({
      endpoint: { kind: 'tcp', host: '127.0.0.1', port: 2375 },
      invalid: null,
    });
  });

  it('config が壊れていたら既定へ落としつつ invalid を返す (黙って別 daemon を見ない)', () => {
    delete process.env.DOCKER_HOST;
    const resolved = resolveEngineEndpoint('ssh://nope');
    expect(resolved.invalid).toBe('ssh://nope');
    expect(resolved.endpoint).toEqual(defaultEndpoint());
  });

  it('config 未設定なら env DOCKER_HOST を使う', () => {
    process.env.DOCKER_HOST = 'tcp://127.0.0.1:2376';
    expect(resolveEngineEndpoint(undefined)).toEqual({
      endpoint: { kind: 'tcp', host: '127.0.0.1', port: 2376 },
      invalid: null,
    });
  });

  it('env が壊れていても既定へ落として invalid を返す', () => {
    process.env.DOCKER_HOST = 'garbage://x';
    const resolved = resolveEngineEndpoint(undefined);
    expect(resolved.invalid).toBe('garbage://x');
    expect(resolved.endpoint).toEqual(defaultEndpoint());
  });
});

describe('describeEndpoint', () => {
  it('tcp / socket をログ用文字列にする', () => {
    expect(describeEndpoint({ kind: 'tcp', host: '127.0.0.1', port: 2375 })).toBe('tcp://127.0.0.1:2375');
    expect(describeEndpoint({ kind: 'socket', socketPath: DEFAULT_UNIX_SOCKET })).toBe(DEFAULT_UNIX_SOCKET);
    expect(describeEndpoint({ kind: 'socket', socketPath: DEFAULT_WINDOWS_PIPE })).toBe(DEFAULT_WINDOWS_PIPE);
  });
});
