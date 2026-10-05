/**
 * コンテナ実行環境のポート転送プロセスの判定 (pure)。
 *
 * docker の `-p 8080:8080` は、host 側では OrbStack / Docker Desktop / Rancher などの転送
 * プロセスが LISTEN する。宣言ポートの採用 (reconcile.ts) がこれをサービスの実体と取り違えると、
 * stop / restart が転送プロセスを殺し、DB を含む全コンテナを道連れにする (2026-10-05 GROMAC で
 * OrbStack を cernere として採用していた)。これらは採用しない。
 */

export interface ProcessDescription {
  name?: string;
  commandLine?: string;
}

const FORWARDER_PATTERNS: readonly RegExp[] = [
  /orbstack/i,
  /com\.docker\.(backend|vpnkit|proxy)/i,
  /(^|[\\/])vpnkit(\.exe)?(\s|$)/i,
  /(^|[\\/])docker-proxy(\.exe)?(\s|$)/i,
  /(^|[\\/])wslrelay(\.exe)?(\s|$)/i,
  /docker desktop/i,
  /rancher desktop/i,
  /(^|[\\/])(limactl|colima)(\s|$)/i,
];

export function isContainerPortForwarder(process: ProcessDescription | null | undefined): boolean {
  if (!process) return false;
  const text = `${process.name ?? ''}\n${process.commandLine ?? ''}`;
  return FORWARDER_PATTERNS.some((pattern) => pattern.test(text));
}
