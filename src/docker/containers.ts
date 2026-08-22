/**
 * `GET /containers/json?all=1` の応答を scanner が使う DockerContainer 形に正規化する。
 * 旧 `docker ps -a --format '{{json .}}'` 置換 (子プロセスを spawn しない)。
 */

import { engineGetJson } from './engine-client.js';

export interface DockerContainer {
  id: string;
  names: string[];          // 1 コンテナに複数 alias が付くため配列
  image: string;
  state: 'running' | 'exited' | 'paused' | 'restarting' | 'created' | 'dead' | string;
  status: string;           // "Up 10 minutes", "Exited (0) 3 hours ago" 等
  ports: string;            // docker ps 互換の "0.0.0.0:5432->5432/tcp, ..." 表記
}

/** Engine API の応答行 (必要なフィールドのみ)。 */
export interface ApiContainer {
  Id?: string;
  Names?: string[];
  Image?: string;
  State?: string;
  Status?: string;
  Ports?: Array<{ IP?: string; PrivatePort?: number; PublicPort?: number; Type?: string }>;
}

/**
 * docker CLI と同じく Rancher backend 不調時にハングし得るため、 タイムアウトで打ち切る。
 * (ハングした CLI が溜まって wsl-helper/ConPTY が孤児化する旧事故の再発防止。)
 */
const LIST_TIMEOUT_MS = 8000;

export async function listContainers(): Promise<DockerContainer[]> {
  const rows = await engineGetJson<ApiContainer[]>('/containers/json?all=1', LIST_TIMEOUT_MS);
  return rows.map(toDockerContainer);
}

export function toDockerContainer(raw: ApiContainer): DockerContainer {
  return {
    id: raw.Id ?? '',
    names: (raw.Names ?? []).map((n) => n.replace(/^\//, '').trim()).filter(Boolean),
    image: raw.Image ?? '',
    state: (raw.State ?? '').toLowerCase(),
    status: raw.Status ?? '',
    ports: formatPorts(raw.Ports ?? []),
  };
}

/** Engine API の Ports 配列を `docker ps` の Ports 列と同じ文字列に整形する (pure)。 */
export function formatPorts(ports: NonNullable<ApiContainer['Ports']>): string {
  return ports
    .map((p) => {
      const proto = p.Type ?? 'tcp';
      if (p.PublicPort == null) return `${p.PrivatePort ?? ''}/${proto}`;
      return `${p.IP ?? '0.0.0.0'}:${p.PublicPort}->${p.PrivatePort ?? ''}/${proto}`;
    })
    .join(', ');
}
