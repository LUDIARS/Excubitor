/**
 * 暗号化の master secret (単一情報源)。
 *
 * config.enc (config-store) と federation の peer secret (secret-box) が
 * 同じ鍵で暗号化/復号できるよう、 導出をここに集約する。
 *   - env EXCUBITOR_MASTER_KEY があれば最優先 (明示指定 / 別マシンへ持ち出す場合)。
 *   - 無ければ KeyStore (win32 は DPAPI、 他は 0600 ファイル) に保管したランダム鍵。
 *     ファイルや DB だけを持ち出しても復号できない (Vault の DEK と同じ水準)。
 *
 * 旧版は hostname + ユーザ名から鍵を決めていた (推測できるので実質無保護)。
 * 旧鍵で暗号化された blob は openWithMasterKeys が旧鍵でも開き、 呼び出し側が新しい鍵で
 * 暗号化し直す (config-store / federation store の移行)。 env 指定時は管理者が鍵を選んでいるので
 * 旧鍵は試さない。
 *
 * 注意: master key を変えると既存の暗号化データは復号できなくなる (config-store と同方針)。
 *
 * @implements SPEC-SECURITY-MASTER-KEY-STORE
 */

import { hostname, userInfo } from 'node:os';
import { decryptJson, type EncryptedBlob } from './crypto.js';
import { excubitorConfigDir } from './config-dir.js';
import { createMasterKeyStore, loadOrCreateMasterKey } from './master-key-store.js';

const cachedKeys = new Map<string, string>();

/** KeyStore の置き場所。 EXCUBITOR_MASTER_KEY_DIR で上書きできる (テスト・移設用)。 */
export function masterKeyDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.EXCUBITOR_MASTER_KEY_DIR;
  return override && override.length > 0 ? override : excubitorConfigDir(env);
}

export function masterSecret(): string {
  const override = process.env.EXCUBITOR_MASTER_KEY;
  if (override && override.length > 0) return override;
  const dir = masterKeyDir();
  const cached = cachedKeys.get(dir);
  if (cached) return cached;
  const key = loadOrCreateMasterKey(createMasterKeyStore(dir)).toString('base64');
  cachedKeys.set(dir, key);
  return key;
}

/** 旧版の推測可能な鍵。 移行 (読み取り) にだけ使い、 新しい暗号化には使わない。 */
export function legacyMasterSecrets(): string[] {
  const override = process.env.EXCUBITOR_MASTER_KEY;
  if (override && override.length > 0) return [];
  return [`excubitor:${hostname()}:${userInfo().username}`];
}

export interface OpenedBlob<T> {
  value: T;
  /** 旧鍵で開けた (新しい鍵で暗号化し直すべき)。 */
  legacy: boolean;
}

/**
 * 現在の鍵 → 旧鍵の順に復号を試す。 どれでも開けなければ最後の復号エラーを投げる。
 * 現在の鍵が用意できない (DPAPI 失敗等) ときは旧鍵へ落とさずにそのエラーを投げる。
 */
export function openWithMasterKeys<T>(blob: EncryptedBlob): OpenedBlob<T> {
  const current = masterSecret();
  try {
    return { value: decryptJson<T>(blob, current), legacy: false };
  } catch (err) {
    for (const legacy of legacyMasterSecrets()) {
      try { return { value: decryptJson<T>(blob, legacy), legacy: true }; } catch { /* try next */ }
    }
    throw err;
  }
}
