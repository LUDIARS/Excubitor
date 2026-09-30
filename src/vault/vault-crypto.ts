/**
 * Vault の値 1 件の暗号化 (AES-256-GCM)。変数名を AAD に入れ、暗号文を別の名前へ付け替えても
 * 復号できないようにする。
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface SealedValue {
  iv: string;
  tag: string;
  ct: string;
}

export function sealValue(key: Buffer, name: string, value: string): SealedValue {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(name, 'utf8'));
  const ct = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}

export function openValue(key: Buffer, name: string, sealed: SealedValue): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
  decipher.setAAD(Buffer.from(name, 'utf8'));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(sealed.ct, 'base64')), decipher.final()]).toString('utf8');
}
