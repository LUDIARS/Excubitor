export interface TerminalProfile {
  id: string; serverName: string; host: string; port: number;
  network: 'private' | 'external'; auth: 'password' | 'key'; hostKey: string;
}
export interface TerminalCredentials { username?: string; password?: string; privateKey?: string; passphrase?: string }
export interface CommandResult { operationId: string; stdout: string; stderr: string; exitCode: number | null; signal: string | null }
const messages: Record<string, string> = {
  not_lan_or_vpn: '接続先がLAN・VPN内のアドレスではありません。外部接続ではSSH鍵を選んでください。',
  external_requires_key: '外部接続ではSSH鍵が必要です。',
  host_key_changed: '接続先のホスト鍵が登録時と異なります。サーバーの管理者に確認してください。',
  host_key_probe_failed: '接続先のホスト鍵を取得できませんでした。ホスト名とポートを確認してください。',
  dns_failed: 'ホスト名から接続先を見つけられませんでした。',
  username_missing: 'Vaultにログイン名を登録してください。', password_missing: 'Vaultにパスワードを登録してください。',
  private_key_missing: 'VaultにSSH秘密鍵を登録してください。',
  ssh_connection_failed: '接続または認証に失敗しました。接続先とVaultの登録内容を確認してください。',
  local_terminal_only: 'ターミナルはExのローカル管理画面から利用してください。',
  command_timeout: '時間制限で接続を閉じました。再実行する前にサーバー側の状態を確認してください。',
  output_limit: '出力量の上限で接続を閉じました。再実行する前にサーバー側の状態を確認してください。',
};
export async function terminalRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api/v1/terminal${path}`, { method,
    headers: { 'content-type': 'application/json', 'x-excubitor-terminal': '1' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(messages[result.error] ?? result.error ?? `HTTP ${response.status}`);
  return result as T;
}
