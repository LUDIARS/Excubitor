/**
 * remote_peers の機密フィールド (agent token / CF-Access secret) の at-rest 暗号化。
 *
 * DB ファイル自体を機密扱いにする前提は残しつつ、 Infisical identity (config.enc) と
 * 同水準で平文を残さないようにする。 鍵は secrets/master-key (= config.enc と同じ master)。
 *
 * 保存形式: 暗号化したら EncryptedBlob を JSON 文字列にして列へ入れる。
 * 後方互換: 既存の平文トークンはそのまま復号せず返す (blob として parse できない値は legacy 平文)。
 * 旧 master 鍵 (hostname + user) の blob も開き、 起動時に新しい鍵で暗号化し直す (store.ts)。
 */

import { encryptJson, isEncryptedBlob } from '../secrets/crypto.js';
import { masterSecret, openWithMasterKeys } from '../secrets/master-key.js';

/** 平文 → 暗号化済み文字列 (DB 列に保存する形)。 */
export function sealSecret(plaintext: string): string {
  return JSON.stringify(encryptJson(plaintext, masterSecret()));
}

/**
 * DB 列の値 → 平文。 暗号化 blob なら復号、 そうでなければ legacy 平文としてそのまま返す。
 * 復号失敗 (master key 変更等) は null を返す (無言で平文扱いして漏らさない)。
 */
export function openSecret(stored: string | null): string | null {
  return openSecretDetailed(stored).value;
}

export interface OpenedSecret {
  value: string | null;
  /** 新しい master 鍵で暗号化し直すべき値 (旧鍵の blob、 または暗号化されていない平文)。 */
  needsReseal: boolean;
}

/** openSecret と同じ判定に、 再暗号化が要るかを添える (起動時の移行用)。 */
export function openSecretDetailed(stored: string | null): OpenedSecret {
  if (stored == null) return { value: null, needsReseal: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return { value: stored, needsReseal: true }; // JSON ですらない = 旧来の平文トークン
  }
  if (!isEncryptedBlob(parsed)) return { value: stored, needsReseal: true }; // JSON だが blob でない = 平文
  try {
    const opened = openWithMasterKeys<string>(parsed);
    return { value: opened.value, needsReseal: opened.legacy };
  } catch {
    return { value: null, needsReseal: false }; // 鍵不一致 / 改竄。 平文へフォールバックしない (機密漏洩防止)。
  }
}
