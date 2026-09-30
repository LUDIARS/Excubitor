/**
 * Vault ファイル (`vault.json`、config.enc と同じディレクトリ) の読み書き。
 *
 * 値は vault-crypto で 1 件ずつ暗号化した形でだけ持つ。変数名・紐付け・取得元ピアは平文
 * (秘密ではなく、画面に一覧を出すため)。拠点のキャッシュも同じ DEK で暗号化する。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { configPath } from '../secrets/config-store.js';

const SealedSchema = z.object({ iv: z.string(), tag: z.string(), ct: z.string() });

export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

const VaultDocSchema = z.object({
  version: z.literal(1),
  entries: z.record(z.object({ sealed: SealedSchema, updated_at: z.number() })).default({}),
  /** サービスコード → そのサービスが使う変数名 (「使用する環境変数」)。 */
  bindings: z.record(z.array(z.string())).default({}),
  /** 拠点: 値を受け取る本社のピア id。本社自身は null。 */
  source_peer_id: z.string().nullable().default(null),
  /** 拠点: 本社から受け取った値の控え。本社に届かないときだけ使う。 */
  cache: z.record(z.object({
    env: z.record(SealedSchema),
    fetched_at: z.number(),
  })).default({}),
});

export type VaultDoc = z.infer<typeof VaultDocSchema>;

export function vaultDir(): string {
  return process.env.EXCUBITOR_VAULT_DIR?.trim() || dirname(configPath());
}

export function vaultFilePath(dir = vaultDir()): string {
  return join(dir, 'vault.json');
}

export function emptyVault(): VaultDoc {
  return { version: 1, entries: {}, bindings: {}, source_peer_id: null, cache: {} };
}

export function readVault(path = vaultFilePath()): VaultDoc {
  if (!existsSync(path)) return emptyVault();
  return VaultDocSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

/** 途中で落ちても壊れたファイルを残さないよう、一時ファイルに書いてから置き換える。 */
export function writeVault(doc: VaultDoc, path = vaultFilePath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(doc, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
}
