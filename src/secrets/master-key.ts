/**
 * 暗号化の master secret (単一情報源)。
 *
 * config.enc (config-store) と federation の peer secret (secret-box) が
 * 同じ鍵で暗号化/復号できるよう、 導出をここに集約する。
 *   - env EXCUBITOR_MASTER_KEY があれば最優先 (明示指定 / 別マシンへ持ち出す場合)。
 *   - 無ければマシン束縛値 (hostname + user)。 → 同一マシンの本人だけが復号できる。
 *
 * 注意: master key を変えると既存の暗号化データは復号できなくなる (config-store と同方針)。
 */

import { hostname, userInfo } from 'node:os';

export function masterSecret(): string {
  const override = process.env.EXCUBITOR_MASTER_KEY;
  if (override && override.length > 0) return override;
  return `excubitor:${hostname()}:${userInfo().username}`;
}
