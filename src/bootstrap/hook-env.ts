/**
 * サービス所有スクリプト (setup / data export / import) へ渡す env を作る。
 *
 * スクリプトは Vault の secret agent から DATABASE_URL 等を取るため、 自拠点の Excubitor の
 * loopback 管理 endpoint と agent token の場所を知っている必要がある。 backend の env に
 * EXCUBITOR_URL / EXCUBITOR_PORT が無い拠点でも解決できるよう、 ここで明示して渡す。
 */

/** backend の既定ポート (server.ts と同じ)。 */
const DEFAULT_EXCUBITOR_PORT = 17332;

/** `EXCUBITOR_PORT` を検証して数値にする。 不正値は無言で既定へ落とさず失敗させる。 */
export function resolveExcubitorPort(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_EXCUBITOR_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('invalid EXCUBITOR_PORT for service-owned script');
  }
  return port;
}

/**
 * serviceToken を渡すと、 そのサービス専用の secret-agent token を EXCUBITOR_AGENT_TOKEN に入れる
 * (クライアントは env をファイルより先に読む)。 token ファイルの場所は旧クライアントのために残す。
 * @implements SPEC-SERVICE-BOOTSTRAP
 * @implements SPEC-SECURITY-AGENT-TOKEN-SPLIT
 */
export function bootstrapHookEnv(base: NodeJS.ProcessEnv, agentTokenPath: string, serviceToken?: string): NodeJS.ProcessEnv {
  const port = resolveExcubitorPort(base.EXCUBITOR_PORT);
  return {
    ...base,
    EXCUBITOR_PORT: String(port),
    // backend は loopback にだけ bind するので、 自拠点の管理 endpoint は常に 127.0.0.1。
    EXCUBITOR_URL: `http://127.0.0.1:${port}`,
    EXCUBITOR_AGENT_TOKEN_PATH: base.EXCUBITOR_AGENT_TOKEN_PATH || agentTokenPath,
    ...(serviceToken ? { EXCUBITOR_AGENT_TOKEN: serviceToken } : {}),
  };
}
