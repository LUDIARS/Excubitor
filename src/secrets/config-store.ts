/**
 * Excubitor 設定ストア。
 *
 * secret/環境設定の単一情報源を **ファイルごと暗号化**して保存する:
 *   - 保存先は AppData (リポジトリ外)。 `%APPDATA%/Excubitor/config.enc`。
 *     → 作業ツリーに置かないので AI/git から普通には見えない。
 *   - ファイル全体を salt 付き AES-256-GCM で暗号化 (crypto.ts)。 siteUrl やサービス
 *     マッピングも含め平文を残さない。 読めても EncryptedBlob (= 鍵が無いと中身不明)。
 *   - master 鍵は EXCUBITOR_MASTER_KEY (env) → 無ければ KeyStore (DPAPI / 0600) のランダム鍵 (master-key.ts)。
 *     旧版の hostname + user 由来の鍵で暗号化されたファイルは読み込み時に新しい鍵で暗号化し直す。
 *
 * 中身 (復号後):
 *   - infisical: legacy encrypted data preserved without applying credentials
 *   - services[code]: read-only legacy requirements used to reject missing Vault migration
 *
 * Legacy identity/mapping data is preserved at rest; no external-provider credentials are applied.
 * 設定が無ければ identity は未設定のまま → UI が入力を促す。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { createNamedLogger } from '../shared/logger.js';
import { encryptJson, decryptJson, isEncryptedBlob, type EncryptedBlob } from './crypto.js';
import { masterSecret, openWithMasterKeys } from './master-key.js';
import { normalizeDiscordWebhookUrl } from '../notify/discord-webhook.js';

const logger = createNamedLogger('excubitor.config');

/** catalog Service['infisical'] と同形 (snake_case)。inject / preflight がそのまま使える。 */
export interface ServiceInfisical {
  project_id: string;
  environment: string;
  inject: boolean;
  prefix: string;
  include?: string[];
  exclude?: string[];
  required_env?: string[];
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
  /**
   * サービス起動時にだけ子プロセスへ渡す完全な runtime config。
   * config.enc 全体が暗号化されるため、個人パスや接続設定を catalog YAML
   * や repository の ignored file へ複製しない。
   */
  serviceRuntimeConfigs?: Record<string, ServiceRuntimeConfig>;
  settings?: {
    domainRoot?: string;
    /** supervisor が Ex backend の health readiness を待つ ms (範囲検証は読み手側)。 */
    backendReadinessTimeoutMs?: number;
    cfTunnel?: CfTunnelSettings;
    notifications?: {
      discord?: DiscordNotificationConfig;
      packageAuditDiscord?: PackageAuditDiscordConfig;
      ergoWatchDiscord?: ErgoWatchDiscordConfig;
    };
  };
}

export interface DiscordNotificationConfig {
  webhookUrl: string;
  enabled: boolean;
  downtimeThresholdSec: number;
  notifyRecovery: boolean;
  /** 本社として、ピアの応答なし・資源アラートもこの webhook へ流す (拠点ごとの設定)。 */
  peerAlerts: boolean;
}

export interface DiscordNotificationStatus {
  configured: boolean;
  enabled: boolean;
  source: 'env' | 'config' | 'unset';
  downtime_threshold_sec: number;
  notify_recovery: boolean;
  peer_alerts: boolean;
  storePath: string;
}

export interface DiscordNotificationInput {
  webhookUrl?: string;
  enabled: boolean;
  downtimeThresholdSec?: number;
  notifyRecovery?: boolean;
  peerAlerts?: boolean;
  clearWebhook?: boolean;
}

export interface PackageAuditDiscordConfig {
  webhookUrl: string;
  enabled: boolean;
}

export interface PackageAuditDiscordStatus {
  configured: boolean;
  enabled: boolean;
  source: 'env' | 'config' | 'unset';
  storePath: string;
}

export interface PackageAuditDiscordInput {
  webhookUrl?: string;
  enabled: boolean;
  clearWebhook?: boolean;
}

/**
 * Ergo パッケージ更新の配送先。 公開ホスト用と非公開ホスト用の 2 本を暗号化 config にだけ持つ
 * (env では受けない)。 未設定の webhook には送らない。
 */
export interface ErgoWatchDiscordConfig {
  webhookUrl: string;
  privateWebhookUrl: string;
  enabled: boolean;
}

export interface ErgoWatchDiscordStatus {
  configured: boolean;
  private_configured: boolean;
  enabled: boolean;
  storePath: string;
}

export interface ErgoWatchDiscordInput {
  webhookUrl?: string;
  privateWebhookUrl?: string;
  enabled: boolean;
  clearWebhook?: boolean;
  clearPrivateWebhook?: boolean;
}

export type ServiceRuntimeConfig = Record<string, unknown>;

export interface ServiceRuntimeConfigStatus {
  configured: boolean;
  keys: string[];
}

/** @implements SPEC-SERVICE-RUNTIME-CONFIG-API */
export class ServiceRuntimeConfigValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ServiceRuntimeConfigValidationError';
  }
}

export const DEFAULT_DOMAIN_ROOT = '';
/** writable=false は「master 鍵を用意できず読めなかった」状態。 上書きで旧データを消さないよう書き込みを拒否する。 */
let configCache: { path: string; mtimeMs: number | null; value: ExcubitorConfig; writable?: false } | null = null;

export type DomainRootSource = 'env' | 'config' | 'unset';

export interface DomainRootStatus {
  value: string;
  source: DomainRootSource;
  configured: boolean;
  env: string | null;
  default_value: string;
  storePath: string;
}

export function normalizeDomainRoot(input: string): string {
  const trimmed = input.trim().toLowerCase().replace(/\/+$/, '');
  if (!trimmed) throw new Error('domain root is required');
  if (trimmed.includes('://') || trimmed.includes('/') || trimmed.includes(',') || /\s/.test(trimmed)) {
    throw new Error('domain root must be a hostname suffix such as example.com');
  }
  if (trimmed === 'localhost') return trimmed;
  const dotted = trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
  const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
  const pattern = new RegExp(`^\\.(?:${label}\\.)+${label}$`);
  if (!pattern.test(dotted)) {
    throw new Error('domain root must be a hostname suffix such as example.com');
  }
  return dotted;
}

/** 保存先: env override → AppData (Win) / ~/.config (他)。 いずれもリポジトリ外。 */
export function configPath(): string {
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
  if (!existsSync(path)) {
    if (configCache?.path === path && configCache.mtimeMs === null) return configCache.value;
    const value: ExcubitorConfig = {};
    configCache = { path, mtimeMs: null, value };
    return value;
  }
  const mtimeMs = statSync(path).mtimeMs;
  if (configCache?.path === path && configCache.mtimeMs === mtimeMs) return configCache.value;
  try {
    const blob = JSON.parse(readFileSync(path, 'utf8')) as EncryptedBlob;
    if (!isEncryptedBlob(blob)) {
      logger.warn('config file is not an encrypted blob — ignoring');
      const value: ExcubitorConfig = {};
      configCache = { path, mtimeMs, value };
      return value;
    }
    try {
      masterSecret();
    } catch (err) {
      // 鍵が用意できないだけで中身は無事。 空扱いで上書きすると消えるので、 書き込みを止める。
      logger.error({ err: (err as Error).message }, 'master key unavailable — config.enc is read-only until it can be loaded');
      const value: ExcubitorConfig = {};
      configCache = { path, mtimeMs, value, writable: false };
      return value;
    }
    const opened = openWithMasterKeys<ExcubitorConfig>(blob);
    configCache = { path, mtimeMs, value: opened.value };
    if (opened.legacy) migrateLegacyConfig(path, opened.value);
    return opened.value;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'config decrypt failed (master key changed?) — treating as empty');
    const value: ExcubitorConfig = {};
    configCache = { path, mtimeMs, value };
    return value;
  }
}

/**
 * 旧 master 鍵 (hostname + user) の config.enc を新しい鍵で暗号化し直す。
 * 一時ファイルに書いてから置き換えるので、 失敗しても旧ファイルは壊れない (次の読み込みで再試行)。
 * @implements SPEC-SECURITY-MASTER-KEY-STORE
 */
function migrateLegacyConfig(path: string, value: ExcubitorConfig): void {
  try {
    writeConfig(value);
    logger.info('config.enc re-encrypted with the stored master key');
  } catch (err) {
    logger.warn({ err: (err as Error).message, path }, 'config.enc re-encryption failed; legacy file kept');
  }
}

/** config 全体を暗号化して書く。 一時ファイル → rename で置き換え、 書いた blob が開けることを確かめてから置く。 */
function writeConfig(cfg: ExcubitorConfig): void {
  const path = configPath();
  if (configCache?.path === path && configCache.writable === false) {
    throw new Error('config.enc is not writable: the master key could not be loaded');
  }
  mkdirSync(dirname(path), { recursive: true });
  const key = masterSecret();
  const blob = encryptJson(cfg, key);
  decryptJson<ExcubitorConfig>(blob, key); // 読めない blob で置き換えない
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(blob), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  configCache = { path, mtimeMs: statSync(path).mtimeMs, value: cfg };
}

export function getDomainRootOverride(): string | null {
  const raw = readConfig().settings?.domainRoot;
  if (!raw) return null;
  try {
    return normalizeDomainRoot(raw);
  } catch (err) {
    logger.warn({ err: (err as Error).message, value: raw }, 'stored domain root is invalid - ignoring');
    return null;
  }
}

export function setDomainRootOverride(input: string): string {
  const value = normalizeDomainRoot(input);
  const cfg = readConfig();
  cfg.settings = { ...(cfg.settings ?? {}), domainRoot: value };
  writeConfig(cfg);
  logger.info({ domainRoot: value }, 'saved domain root setting');
  return value;
}

export function getDomainRootStatus(): DomainRootStatus {
  const envValue = (process.env.EXCUBITOR_DOMAIN_ROOT ?? '').trim();
  const env = envValue ? normalizeDomainRoot(envValue) : null;
  const configured = getDomainRootOverride();
  const value = env ?? configured ?? DEFAULT_DOMAIN_ROOT;
  const source: DomainRootSource = env ? 'env' : configured ? 'config' : 'unset';
  return {
    value,
    source,
    configured: configured !== null,
    env,
    default_value: DEFAULT_DOMAIN_ROOT,
    storePath: configPath(),
  };
}

/**
 * 保存済みの backend readiness timeout (ms) の生値。 未設定は null。
 * env `EXCUBITOR_BACKEND_READINESS_TIMEOUT_MS` が優先し、範囲検証は
 * local-control/backend-readiness-timeout.ts が行う (domainRoot と同じ規則)。
 *
 * @implements SPEC-EX-BACKEND-READINESS
 */
export function getBackendReadinessTimeoutOverride(): unknown {
  return readConfig().settings?.backendReadinessTimeoutMs ?? null;
}

// ─────────────── CF Tunnel (cf-tunnel ブローカー設定) ───────────────

/**
 * cf-tunnel ブローカーの config 由来設定。 CF_API_TOKEN / CF_ACCOUNT_ID そのものは
 * Excubitor の Vault に置き (cf-tunnel/credentials.ts)、 ここには hostname allowlist だけを持つ。
 * env (EXCUBITOR_CF_TUNNEL_ALLOWED_HOSTNAMES) が設定されていれば常に env が優先される
 * (domainRoot と同じ規則)。
 */
export interface CfTunnelSettings {
  allowedHostnames?: string[];
}

export type CfTunnelSource = 'env' | 'config' | 'unset';

export interface CfTunnelStatus {
  allowed_hostnames: string[];
  allowed_hostnames_source: CfTunnelSource;
  /**
   * config store に実際に保存されている値 (env で隠れていても素の値)。
   * 上の解決済みフィールドは env 優先なので、 編集 UI がこれを使わず解決値を
   * 下書きに入れると、 env の値をそのまま保存して既存の config を上書きしてしまう。
   */
  stored: {
    allowed_hostnames: string[];
  };
  /** EXCUBITOR_CF_API_TOKEN + EXCUBITOR_CF_ACCOUNT_ID の直指定があるか (UI 表示用)。 */
  direct_env_credentials: boolean;
  storePath: string;
}

export interface CfTunnelInput {
  allowedHostnames?: string[];
}

/** hostname は小文字比較で使うため保存時に正規化する。 空要素は捨てる。 */
function normalizeCfHostnames(hostnames: string[]): string[] {
  const seen = new Set<string>();
  for (const raw of hostnames) {
    const h = raw.trim().toLowerCase();
    if (!h) continue;
    if (h.includes('://') || h.includes('/') || h.includes(',') || /\s/.test(h)) {
      throw new Error(`allowlist hostname が不正: "${raw}" (スキーム・パス・空白は含められない)`);
    }
    seen.add(h);
  }
  return [...seen];
}

/** @implements SPEC-CF-TUNNEL-ROUTES */
export function getCfTunnelSettings(): CfTunnelSettings {
  return readConfig().settings?.cfTunnel ?? {};
}

/**
 * 部分更新: 渡されたフィールドだけを上書きする。 空文字 / 空配列はそのフィールドの
 * 設定解除 (undefined) として扱う。
 * @implements SPEC-CF-TUNNEL-ROUTES
 */
export function saveCfTunnelSettings(input: CfTunnelInput): CfTunnelStatus {
  const cfg = readConfig();
  const current = cfg.settings?.cfTunnel ?? {};
  // 旧版が保存した Infisical project/env は読み捨て、 書き戻さない。
  const next: CfTunnelSettings = {
    allowedHostnames:
      input.allowedHostnames !== undefined
        ? (() => {
            const normalized = normalizeCfHostnames(input.allowedHostnames);
            return normalized.length > 0 ? normalized : undefined;
          })()
        : current.allowedHostnames,
  };
  cfg.settings = { ...(cfg.settings ?? {}), cfTunnel: next };
  writeConfig(cfg);
  logger.info(
    {
      allowlistCount: next.allowedHostnames?.length ?? 0,
    },
    'saved cf-tunnel settings',
  );
  return getCfTunnelStatus();
}

/** @implements SPEC-CF-TUNNEL-ROUTES */
export function getCfTunnelStatus(): CfTunnelStatus {
  const stored = getCfTunnelSettings();
  const envAllowlist = (process.env.EXCUBITOR_CF_TUNNEL_ALLOWED_HOSTNAMES ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);
  const sourceOf = (env: unknown, config: unknown): CfTunnelSource =>
    env ? 'env' : config ? 'config' : 'unset';
  return {
    // config cache と同じ配列を渡さない (呼び出し側の mutate が cache を壊す)。
    allowed_hostnames: envAllowlist.length > 0 ? envAllowlist : [...(stored.allowedHostnames ?? [])],
    allowed_hostnames_source: sourceOf(
      envAllowlist.length > 0,
      stored.allowedHostnames && stored.allowedHostnames.length > 0,
    ),
    stored: {
      allowed_hostnames: [...(stored.allowedHostnames ?? [])],
    },
    direct_env_credentials: Boolean(
      process.env.EXCUBITOR_CF_API_TOKEN?.trim() && process.env.EXCUBITOR_CF_ACCOUNT_ID?.trim(),
    ),
    storePath: configPath(),
  };
}

export function getDiscordNotificationConfig(): DiscordNotificationConfig | null {
  const envUrl = process.env.EXCUBITOR_DISCORD_WEBHOOK_URL?.trim();
  const stored = readConfig().settings?.notifications?.discord;
  const webhookUrl = envUrl ? normalizeDiscordWebhookUrl(envUrl) : stored?.webhookUrl;
  if (!webhookUrl) return null;
  return {
    webhookUrl: normalizeDiscordWebhookUrl(webhookUrl),
    enabled: stored?.enabled ?? true,
    downtimeThresholdSec: normalizeDowntimeThreshold(stored?.downtimeThresholdSec),
    notifyRecovery: stored?.notifyRecovery ?? true,
    peerAlerts: stored?.peerAlerts ?? false,
  };
}

export function getDiscordNotificationStatus(): DiscordNotificationStatus {
  const envUrl = process.env.EXCUBITOR_DISCORD_WEBHOOK_URL?.trim();
  const config = getDiscordNotificationConfig();
  return {
    configured: config !== null,
    enabled: config?.enabled ?? false,
    source: envUrl ? 'env' : config ? 'config' : 'unset',
    downtime_threshold_sec: config?.downtimeThresholdSec ?? 60,
    notify_recovery: config?.notifyRecovery ?? true,
    peer_alerts: config?.peerAlerts ?? false,
    storePath: configPath(),
  };
}

export function saveDiscordNotificationConfig(input: DiscordNotificationInput): DiscordNotificationStatus {
  const cfg = readConfig();
  const current = cfg.settings?.notifications?.discord;
  const webhookUrl = input.clearWebhook
    ? ''
    : input.webhookUrl?.trim()
      ? normalizeDiscordWebhookUrl(input.webhookUrl)
      : current?.webhookUrl ?? '';
  if (input.enabled && !webhookUrl && !process.env.EXCUBITOR_DISCORD_WEBHOOK_URL?.trim()) {
    throw new Error('Discord webhook URL is required when notifications are enabled');
  }
  const discord: DiscordNotificationConfig = {
    webhookUrl,
    enabled: input.enabled,
    downtimeThresholdSec: normalizeDowntimeThreshold(input.downtimeThresholdSec),
    notifyRecovery: input.notifyRecovery ?? true,
    peerAlerts: input.peerAlerts ?? current?.peerAlerts ?? false,
  };
  cfg.settings = {
    ...(cfg.settings ?? {}),
    notifications: {
      ...(cfg.settings?.notifications ?? {}),
      discord,
    },
  };
  writeConfig(cfg);
  logger.info({ enabled: discord.enabled }, 'saved Discord notification settings');
  return getDiscordNotificationStatus();
}

/**
 * パッケージ監査専用 webhook。downtime 通知とは別の URL を暗号化 config に持つ。
 *
 * @implements SPEC-PACKAGE-UPDATE-AUDIT
 */
export function getPackageAuditDiscordConfig(): PackageAuditDiscordConfig | null {
  const envUrl = process.env.EXCUBITOR_PACKAGE_AUDIT_DISCORD_WEBHOOK_URL?.trim();
  const stored = readConfig().settings?.notifications?.packageAuditDiscord;
  const webhookUrl = envUrl ? normalizeDiscordWebhookUrl(envUrl) : stored?.webhookUrl;
  if (!webhookUrl) return null;
  return {
    webhookUrl: normalizeDiscordWebhookUrl(webhookUrl),
    enabled: stored?.enabled ?? true,
  };
}

/** @implements SPEC-PACKAGE-UPDATE-AUDIT */
export function getPackageAuditDiscordStatus(): PackageAuditDiscordStatus {
  const envUrl = process.env.EXCUBITOR_PACKAGE_AUDIT_DISCORD_WEBHOOK_URL?.trim();
  const config = getPackageAuditDiscordConfig();
  return {
    configured: config !== null,
    enabled: config?.enabled ?? false,
    source: envUrl ? 'env' : config ? 'config' : 'unset',
    storePath: configPath(),
  };
}

/** @implements SPEC-PACKAGE-UPDATE-AUDIT */
export function savePackageAuditDiscordConfig(
  input: PackageAuditDiscordInput,
): PackageAuditDiscordStatus {
  const cfg = readConfig();
  const current = cfg.settings?.notifications?.packageAuditDiscord;
  const webhookUrl = input.clearWebhook
    ? ''
    : input.webhookUrl?.trim()
      ? normalizeDiscordWebhookUrl(input.webhookUrl)
      : current?.webhookUrl ?? '';
  if (
    input.enabled
    && !webhookUrl
    && !process.env.EXCUBITOR_PACKAGE_AUDIT_DISCORD_WEBHOOK_URL?.trim()
  ) {
    throw new Error('Package audit Discord webhook URL is required when notifications are enabled');
  }
  const packageAuditDiscord: PackageAuditDiscordConfig = {
    webhookUrl,
    enabled: input.enabled,
  };
  cfg.settings = {
    ...(cfg.settings ?? {}),
    notifications: {
      ...(cfg.settings?.notifications ?? {}),
      packageAuditDiscord,
    },
  };
  writeConfig(cfg);
  logger.info({ enabled: packageAuditDiscord.enabled }, 'saved package audit Discord notification settings');
  return getPackageAuditDiscordStatus();
}

/**
 * Ergo パッケージ更新の配送先 webhook。 値は暗号化 config にだけ置き、 API・ログへ返さない。
 *
 * @implements SPEC-ERGO-WATCH-DELIVERY
 */
export function getErgoWatchDiscordConfig(): ErgoWatchDiscordConfig | null {
  const stored = readConfig().settings?.notifications?.ergoWatchDiscord;
  if (!stored) return null;
  return {
    webhookUrl: stored.webhookUrl ? normalizeDiscordWebhookUrl(stored.webhookUrl) : '',
    privateWebhookUrl: stored.privateWebhookUrl ? normalizeDiscordWebhookUrl(stored.privateWebhookUrl) : '',
    enabled: stored.enabled,
  };
}

/** @implements SPEC-ERGO-WATCH-DELIVERY */
export function getErgoWatchDiscordStatus(): ErgoWatchDiscordStatus {
  const config = getErgoWatchDiscordConfig();
  return {
    configured: Boolean(config?.webhookUrl),
    private_configured: Boolean(config?.privateWebhookUrl),
    enabled: config?.enabled ?? false,
    storePath: configPath(),
  };
}

/** @implements SPEC-ERGO-WATCH-DELIVERY */
export function saveErgoWatchDiscordConfig(input: ErgoWatchDiscordInput): ErgoWatchDiscordStatus {
  const cfg = readConfig();
  const current = cfg.settings?.notifications?.ergoWatchDiscord;
  const pick = (clear: boolean | undefined, next: string | undefined, prev: string | undefined): string => (
    clear ? '' : next?.trim() ? normalizeDiscordWebhookUrl(next) : prev ?? ''
  );
  const ergoWatchDiscord: ErgoWatchDiscordConfig = {
    webhookUrl: pick(input.clearWebhook, input.webhookUrl, current?.webhookUrl),
    privateWebhookUrl: pick(input.clearPrivateWebhook, input.privateWebhookUrl, current?.privateWebhookUrl),
    enabled: input.enabled,
  };
  if (ergoWatchDiscord.enabled && !ergoWatchDiscord.webhookUrl) {
    throw new Error('Ergo watch Discord webhook URL is required when notifications are enabled');
  }
  cfg.settings = {
    ...(cfg.settings ?? {}),
    notifications: {
      ...(cfg.settings?.notifications ?? {}),
      ergoWatchDiscord,
    },
  };
  writeConfig(cfg);
  logger.info({ enabled: ergoWatchDiscord.enabled }, 'saved Ergo watch Discord notification settings');
  return getErgoWatchDiscordStatus();
}

function normalizeDowntimeThreshold(value: number | undefined): number {
  if (value === undefined) return 60;
  if (!Number.isFinite(value)) throw new Error('downtime threshold must be finite');
  return Math.max(60, Math.min(86_400, Math.floor(value)));
}

// ─────────────── per-service mappings ───────────────

export function getServiceMap(): Record<string, ServiceInfisical> {
  return readConfig().services ?? {};
}

// ─────────────── per-service runtime configuration ───────────────

function normalizeServiceCode(code: string): string {
  if (!/^[a-z][a-z0-9-]*$/.test(code)) {
    throw new ServiceRuntimeConfigValidationError(
      'service code must contain lowercase letters, digits, and hyphens only',
    );
  }
  return code;
}

function normalizeRuntimeConfig(value: unknown): ServiceRuntimeConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ServiceRuntimeConfigValidationError('runtime config must be a JSON object');
  }
  try {
    const cloned = JSON.parse(JSON.stringify(value)) as unknown;
    if (typeof cloned !== 'object' || cloned === null || Array.isArray(cloned)) {
      throw new ServiceRuntimeConfigValidationError('runtime config must be a JSON object');
    }
    return cloned as ServiceRuntimeConfig;
  } catch (error) {
    if (error instanceof ServiceRuntimeConfigValidationError) throw error;
    throw new ServiceRuntimeConfigValidationError('runtime config must be JSON-serializable', { cause: error });
  }
}

/**
 * 復号済み runtime config。呼び出し元が保存済みのオブジェクトを変更しても
 * config cache を壊さないよう、毎回 clone を返す。
 */
export function getServiceRuntimeConfig(code: string): ServiceRuntimeConfig | null {
  const key = normalizeServiceCode(code);
  const configured = readConfig().serviceRuntimeConfigs?.[key];
  return configured === undefined ? null : normalizeRuntimeConfig(configured);
}

/** @implements SPEC-SERVICE-RUNTIME-CONFIG-API */
export function getServiceRuntimeConfigStatus(code: string): ServiceRuntimeConfigStatus {
  const config = getServiceRuntimeConfig(code);
  return {
    configured: config !== null,
    keys: config === null ? [] : Object.keys(config).sort(),
  };
}

/**
 * null は設定削除。値の本文は API response / log に出さない。
 * @implements SPEC-SERVICE-RUNTIME-CONFIG-API
 */
export function saveServiceRuntimeConfig(
  code: string,
  value: ServiceRuntimeConfig | null,
): ServiceRuntimeConfigStatus {
  const key = normalizeServiceCode(code);
  // 検証は store へ触れる前に済ませる (不正入力で config を読み書きしない)。
  const stored = value === null ? null : normalizeRuntimeConfig(value);
  const cfg = readConfig();
  const map = { ...(cfg.serviceRuntimeConfigs ?? {}) };
  if (stored === null) delete map[key];
  else map[key] = stored;
  cfg.serviceRuntimeConfigs = map;
  writeConfig(cfg);
  // status は保存した値から直接組み立てる (復号と clone をもう一度回さない)。
  const status: ServiceRuntimeConfigStatus = {
    configured: stored !== null,
    keys: stored === null ? [] : Object.keys(stored).sort(),
  };
  logger.info({ code: key, ...status }, 'saved encrypted service runtime configuration');
  return status;
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
