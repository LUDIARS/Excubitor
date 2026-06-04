/**
 * secret の salt 付き暗号化 (平文保存しないため)。
 *
 * - 一方向 hash ではなく可逆暗号 (認証時に元の値が必要なため)。
 * - scrypt(masterSecret, salt) で鍵導出 → AES-256-GCM。
 * - master secret は呼び出し側が渡す (env override / マシン束縛値は config-store が決める)。
 *
 * 形式 (EncryptedBlob): すべて base64。salt はレコード毎にランダム。
 */

import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';

export interface EncryptedBlob {
  v: 1;
  salt: string;
  iv: string;
  tag: string;
  data: string;
}

function deriveKey(masterSecret: string, salt: Buffer): Buffer {
  return scryptSync(masterSecret, salt, 32);
}

/** 任意の JSON 値を暗号化する。 */
export function encryptJson(value: unknown, masterSecret: string): EncryptedBlob {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(masterSecret, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: enc.toString('base64'),
  };
}

/** encryptJson の逆。改竄/鍵不一致は throw。 */
export function decryptJson<T = unknown>(blob: EncryptedBlob, masterSecret: string): T {
  const salt = Buffer.from(blob.salt, 'base64');
  const iv = Buffer.from(blob.iv, 'base64');
  const tag = Buffer.from(blob.tag, 'base64');
  const key = deriveKey(masterSecret, salt);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(Buffer.from(blob.data, 'base64')), decipher.final()]);
  return JSON.parse(dec.toString('utf8')) as T;
}

export function isEncryptedBlob(x: unknown): x is EncryptedBlob {
  return (
    typeof x === 'object' &&
    x !== null &&
    (x as EncryptedBlob).v === 1 &&
    typeof (x as EncryptedBlob).salt === 'string' &&
    typeof (x as EncryptedBlob).data === 'string'
  );
}
