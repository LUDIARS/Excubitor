import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Excubitor の per-user 設定ディレクトリ (リポジトリ外)。
 * config.enc / secret-agent.token / master 鍵 / mesh token をここに置く。
 *   Windows: %APPDATA%/Excubitor、 他: $XDG_CONFIG_HOME/Excubitor か ~/.config/Excubitor。
 */
export function excubitorConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.APPDATA ?? env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return join(base, 'Excubitor');
}
