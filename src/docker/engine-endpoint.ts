/**
 * Docker Engine API の接続先 (endpoint) 解決。
 *
 * docker CLI は Windows では Rancher Desktop の `wsl-helper docker-proxy` が提供する
 * 名前付きパイプ経由で backend に届く。 CLI を 1 回 spawn するたびに wsl-helper 側で
 * 10 個強のハンドルが回収されず積み上がり、 数日で WSAENOBUFS (Rancher 死亡) に至る。
 * Engine API を直接叩くと残留ハンドルは 1/10 になり、 WSL 内の dockerd を TCP で公開して
 * `tcp://127.0.0.1:2375` を指せば wsl-helper を完全に経由しなくなる。
 *
 * 優先順: catalog `docker.host` → env `DOCKER_HOST` → プラットフォーム既定。
 */

export type EngineEndpoint =
  | { kind: 'tcp'; host: string; port: number }
  | { kind: 'socket'; socketPath: string };

export const DEFAULT_WINDOWS_PIPE = '\\\\.\\pipe\\docker_engine';
export const DEFAULT_UNIX_SOCKET = '/var/run/docker.sock';

/** 文字列 (DOCKER_HOST 互換) を endpoint に解釈する (pure)。 解釈不能なら null。 */
export function parseEngineHost(raw: string | undefined | null, platform = process.platform): EngineEndpoint | null {
  const value = (raw ?? '').trim();
  if (value.length === 0) return defaultEndpoint(platform);

  // `[::1]:2375` 形式の IPv6 リテラルも受ける (bracket は http.request 側で外れる)。
  const tcp6 = value.match(/^tcp:\/\/(\[[0-9a-f:]+\])(?::(\d+))?\/?$/i);
  const tcp = tcp6 ?? value.match(/^tcp:\/\/([^/:]+)(?::(\d+))?\/?$/i);
  if (tcp) {
    const port = tcp[2] ? Number(tcp[2]) : 2375;
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
    const host = tcp[1] ?? 'localhost';
    return { kind: 'tcp', host: tcp6 ? host.slice(1, -1) : host, port };
  }

  const npipe = value.match(/^npipe:\/\/(.+)$/i);
  if (npipe) {
    // docker CLI 表記 `npipe:////./pipe/docker_engine` → `\\.\pipe\docker_engine`
    const path = (npipe[1] ?? '').replace(/^\/+/, '').replace(/\//g, '\\');
    return { kind: 'socket', socketPath: `\\\\${path}` };
  }

  const unix = value.match(/^unix:\/\/(.+)$/i);
  if (unix?.[1]) return { kind: 'socket', socketPath: unix[1] };

  return null;
}

export function defaultEndpoint(platform = process.platform): EngineEndpoint {
  return platform === 'win32'
    ? { kind: 'socket', socketPath: DEFAULT_WINDOWS_PIPE }
    : { kind: 'socket', socketPath: DEFAULT_UNIX_SOCKET };
}

/** 解決済み endpoint。 起動時に configureEngineEndpoint で差し替える。 */
let current: EngineEndpoint = parseEngineHost(process.env.DOCKER_HOST) ?? defaultEndpoint();

/**
 * 解決結果と、 解釈できなかった入力 (あれば) を返す。 誤設定を黙って既定へ落とすと
 * 別の daemon を監視し続けて気付けないため、 呼び出し側で warn を出せるようにする。
 */
export function resolveEngineEndpoint(configHost: string | undefined): {
  endpoint: EngineEndpoint;
  invalid: string | null;
} {
  const trimmedConfig = configHost?.trim();
  if (trimmedConfig) {
    const fromConfig = parseEngineHost(trimmedConfig);
    if (fromConfig) return { endpoint: fromConfig, invalid: null };
    return { endpoint: parseEngineHost(process.env.DOCKER_HOST) ?? defaultEndpoint(), invalid: trimmedConfig };
  }
  const envHost = process.env.DOCKER_HOST?.trim();
  if (envHost) {
    const fromEnv = parseEngineHost(envHost);
    if (fromEnv) return { endpoint: fromEnv, invalid: null };
    return { endpoint: defaultEndpoint(), invalid: envHost };
  }
  return { endpoint: defaultEndpoint(), invalid: null };
}

export function configureEngineEndpoint(configHost: string | undefined): EngineEndpoint {
  current = resolveEngineEndpoint(configHost).endpoint;
  return current;
}

export function engineEndpoint(): EngineEndpoint {
  return current;
}

export function describeEndpoint(ep: EngineEndpoint): string {
  return ep.kind === 'tcp' ? `tcp://${ep.host}:${ep.port}` : ep.socketPath;
}
