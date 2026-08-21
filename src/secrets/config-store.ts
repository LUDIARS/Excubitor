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

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { createNamedLogger } from '../shared/logger.js';
import { encryptJson, decryptJson, isEncryptedBlob, type EncryptedBlob } from './crypto.js';
import { masterSecret } from './master-key.js';
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
  settings?: {
    domainRoot?: string;
    cfTunnel?: CfTunnelSettings;
    notifications?: {
      discord?: DiscordNotificationConfig;
      packageAuditDiscord?: PackageAuditDiscordConfig;
    };
  };
}

export interface DiscordNotificationConfig {
  webhookUrl: string;
  enabled: boolean;
  downtimeThresholdSec: number;
  notifyRecovery: boolean;
}

export interface DiscordNotificationStatus {
  configured: boolean;
  enabled: boolean;
  source: 'env' | 'config' | 'unset';
  downtime_threshold_sec: number;
  notify_recovery: boolean;
  storePath: string;
}

export interface DiscordNotificationInput {
  webhookUrl?: string;
  enabled: boolean;
  downtimeThresholdSec?: number;
  notifyRecovery?: boolean;
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

export const DEFAULT_DOMAIN_ROOT = '';
let configCache: { path: string; mtimeMs: number | null; value: ExcubitorConfig } | null = null;

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
    const value = decryptJson<ExcubitorConfig>(blob, masterSecret());
    configCache = { path, mtimeMs, value };
    return value;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'config decrypt failed (master key changed?) — treating as empty');
    const value: ExcubitorConfig = {};
    configCache = { path, mtimeMs, value };
    return value;
  }
}

/** config 全体を暗号化して書く。 */
function writeConfig(cfg: ExcubitorConfig): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  const blob = encryptJson(cfg, masterSecret());
  writeFileSync(path, JSON.stringify(blob), 'utf8');
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

// ─────────────── CF Tunnel (cf-tunnel ブローカー設定) ───────────────

/**
 * cf-tunnel ブローカーの config 由来設定。 CF_API_TOKEN そのものは Infisical に置き、
 * ここには「どの project/env から取るか」と hostname allowlist だけを持つ。
 * env (EXCUBITOR_CF_*) が設定されていれば常に env が優先される (domainRoot と同じ規則)。
 */
export interface CfTunnelSettings {
  infisicalProjectId?: string;
  infisicalEnvironment?: string;
  allowedHostnames?: string[];
}

export type CfTunnelSource = 'env' | 'config' | 'unset';

export interface CfTunnelStatus {
  infisical_project_id: string | null;
  infisical_project_source: CfTunnelSource;
  infisical_environment: string | null;
  infisical_environment_source: CfTunnelSource;
  allowed_hostnames: string[];
  allowed_hostnames_source: CfTunnelSource;
  /** EXCUBITOR_CF_API_TOKEN + EXCUBITOR_CF_ACCOUNT_ID の直指定があるか (UI 表示用)。 */
  direct_env_credentials: boolean;
  storePath: string;
}

export interface CfTunnelInput {
  infisicalProjectId?: string;
  infisicalEnvironment?: string;
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
  const next: CfTunnelSettings = {
    infisicalProjectId:
      input.infisicalProjectId !== undefined
        ? input.infisicalProjectId.trim() || undefined
        : current.infisicalProjectId,
    infisicalEnvironment:
      input.infisicalEnvironment !== undefined
        ? input.infisicalEnvironment.trim() || undefined
        : current.infisicalEnvironment,
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
      hasProject: Boolean(next.infisicalProjectId),
      environment: next.infisicalEnvironment ?? null,
      allowlistCount: next.allowedHostnames?.length ?? 0,
    },
    'saved cf-tunnel settings',
  );
  return getCfTunnelStatus();
}

/** @implements SPEC-CF-TUNNEL-ROUTES */
export function getCfTunnelStatus(): CfTunnelStatus {
  const stored = getCfTunnelSettings();
  const envProject = process.env.EXCUBITOR_CF_INFISICAL_PROJECT_ID?.trim() || null;
  const envEnvironment = process.env.EXCUBITOR_CF_INFISICAL_ENV?.trim() || null;
  const envAllowlist = (process.env.EXCUBITOR_CF_TUNNEL_ALLOWED_HOSTNAMES ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);
  const sourceOf = (env: unknown, config: unknown): CfTunnelSource =>
    env ? 'env' : config ? 'config' : 'unset';
  return {
    infisical_project_id: envProject ?? stored.infisicalProjectId ?? null,
    infisical_project_source: sourceOf(envProject, stored.infisicalProjectId),
    infisical_environment: envEnvironment ?? stored.infisicalEnvironment ?? null,
    infisical_environment_source: sourceOf(envEnvironment, stored.infisicalEnvironment),
    allowed_hostnames: envAllowlist.length > 0 ? envAllowlist : stored.allowedHostnames ?? [],
    allowed_hostnames_source: sourceOf(
      envAllowlist.length > 0,
      stored.allowedHostnames && stored.allowedHostnames.length > 0,
    ),
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

function normalizeDowntimeThreshold(value: number | undefined): number {
  if (value === undefined) return 60;
  if (!Number.isFinite(value)) throw new Error('downtime threshold must be finite');
  return Math.max(60, Math.min(86_400, Math.floor(value)));
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
