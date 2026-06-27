/**
 * Excubitor 設定ストア。
 *
 * secret/環境設定の単一情報源を **ファイルごと暗号化**して保存する:
 *   - 保存先は AppData (リポジトリ外)。 `%APPDATA%/Excubitor/config.enc`。
 *     → 作業ツリーに置かないので AI/git から普通には見えない。
 *   - ファイル全体を salt 付き AES-256-GCM で暗号化 (crypto.ts)。 siteUrl やサービス
 *     マッピングも含め平文を残さない。 読めても EncryptedBlob (= 鍵が無いと中身不明)。
 *   - master 鍵は EXCUBITOR_MASTER_KEY (env) → 無ければマシン束縛値 (hostname + user)。
 *
 * 中身 (復号後):
 *   - infisical: Excubitor 自身の machine identity (siteUrl / environment / clientId / clientSecret)
 *   - services[code]: 各サービスの Infisical マッピング (catalog yaml の代替、 こちらを優先)
 *
 * boot 時 `applyInfisicalToEnv()` で identity を process.env.INFISICAL_* に注入 (既存 env 優先)。
 * 設定が無ければ identity は未設定のまま → UI が入力を促す。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { createNamedLogger } from '../shared/logger.js';
import { encryptJson, decryptJson, isEncryptedBlob, type EncryptedBlob } from './crypto.js';
import { masterSecret } from './master-key.js';

const logger = createNamedLogger('excubitor.config');

/** catalog Service['infisical'] と同形 (snake_case)。inject / preflight がそのまま使える。 */
export interface ServiceInfisical {
  project_id: string;
  environment: string;
  inject: boolean;
  prefix: string;
  include?: string[];
  exclude?: string[];
}

interface InfisicalIdentity {
  siteUrl: string;
  environment: string;
  clientId: string;
  clientSecret: string;
}

interface ExcubitorConfig {
  infisical?: InfisicalIdentity;
  services?: Record<string, ServiceInfisical>;
}

/** 保存先: env override → AppData (Win) / ~/.config (他)。 いずれもリポジトリ外。 */
function configPath(): string {
  const override = process.env.EXCUBITOR_CONFIG_PATH;
  if (override && override.length > 0) return override;
  const base =
    process.env.APPDATA ?? // Windows: C:\Users\<user>\AppData\Roaming
    process.env.XDG_CONFIG_HOME ??
    join(homedir(), '.config');
  return join(base, 'Excubitor', 'config.enc');
}

/** 暗号化ファイルを復号して読む。 未存在 / 復号失敗は空 config 扱い。 */
function readConfig(): ExcubitorConfig {
  const path = configPath();
  if (!existsSync(path)) return {};
  try {
    const blob = JSON.parse(readFileSync(path, 'utf8')) as EncryptedBlob;
    if (!isEncryptedBlob(blob)) {
      logger.warn('config file is not an encrypted blob — ignoring');
      return {};
    }
    return decryptJson<ExcubitorConfig>(blob, masterSecret());
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'config decrypt failed (master key changed?) — treating as empty');
    return {};
  }
}

/** config 全体を暗号化して書く。 */
function writeConfig(cfg: ExcubitorConfig): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  const blob = encryptJson(cfg, masterSecret());
  writeFileSync(path, JSON.stringify(blob), 'utf8');
}

// ─────────────── Identity ───────────────

export interface IdentityInput {
  siteUrl: string;
  environment?: string;
  clientId: string;
  clientSecret: string;
}

export interface IdentityStatus {
  configured: boolean;
  siteUrl: string | null;
  environment: string | null;
  /** clientId の末尾数文字のみ (UI 表示用、平文 secret は返さない)。 */
  clientIdHint: string | null;
  /** 暗号化設定ファイルの保存先 (UI 表示用)。 */
  storePath: string;
}

export function saveInfisicalIdentity(input: IdentityInput): void {
  const cfg = readConfig();
  cfg.infisical = {
    siteUrl: input.siteUrl.replace(/\/$/, ''),
    environment: input.environment ?? 'dev',
    clientId: input.clientId,
    clientSecret: input.clientSecret,
  };
  writeConfig(cfg);
  logger.info({ siteUrl: cfg.infisical.siteUrl }, 'saved Infisical identity (encrypted to AppData)');
}

/** 復号した identity。未設定 / 復号失敗時は null。 */
export function getInfisicalIdentity(): InfisicalIdentity | null {
  return readConfig().infisical ?? null;
}

export function getIdentityStatus(): IdentityStatus {
  const id = getInfisicalIdentity();
  return {
    configured: id !== null,
    siteUrl: id?.siteUrl ?? null,
    environment: id?.environment ?? null,
    clientIdHint: id ? `…${id.clientId.slice(-4)}` : null,
    storePath: configPath(),
  };
}

/**
 * identity を process.env.INFISICAL_* に注入する (既存 env を上書きしない)。
 * boot で 1 回呼ぶ。 secrets/infisical.ts の readIdentity がこれを読む。
 */
export function applyInfisicalToEnv(): boolean {
  const id = getInfisicalIdentity();
  if (!id) return false;
  if (!process.env.INFISICAL_SITE_URL) process.env.INFISICAL_SITE_URL = id.siteUrl;
  if (!process.env.INFISICAL_CLIENT_ID) process.env.INFISICAL_CLIENT_ID = id.clientId;
  if (!process.env.INFISICAL_CLIENT_SECRET) process.env.INFISICAL_CLIENT_SECRET = id.clientSecret;
  if (!process.env.INFISICAL_ENVIRONMENT) process.env.INFISICAL_ENVIRONMENT = id.environment;
  logger.info('applied Infisical identity to process env');
  return true;
}

// ─────────────── per-service mappings ───────────────

export function getServiceMap(): Record<string, ServiceInfisical> {
  return readConfig().services ?? {};
}

export function setServiceMap(services: Record<string, ServiceInfisical>): void {
  const cfg = readConfig();
  cfg.services = services;
  writeConfig(cfg);
  logger.info({ count: Object.keys(services).length }, 'saved service Infisical map (encrypted)');
}

/**
 * サービスの Infisical 設定を解決する。 Excubitor 設定を優先し、 無ければ catalog の値。
 * これにより「全部 Excubitor の設定に入れておく」 (catalog 非依存) が成立する。
 */
export function resolveServiceInfisical(
  code: string,
  catalogFallback?: ServiceInfisical,
): ServiceInfisical | undefined {
  return getServiceMap()[code] ?? catalogFallback;
}
