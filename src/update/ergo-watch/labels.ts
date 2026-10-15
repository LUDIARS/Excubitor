/**
 * 出来事の各値を本文用の短い表記へ変える (伏せ字 → 縮約 → Discord エスケープ)。
 *
 * @implements SPEC-ERGO-WATCH-DELIVERY
 */

import { escapeDiscord } from '../../notify/discord-messages.js';
import { redactValue } from './redact.js';

const OWNER_LABEL: Record<string, string> = {
  host: 'ホストの宣言',
  ergo: 'Ergo のマニフェスト',
  upm: 'Unity の Packages/manifest.json',
};

const ORIGIN_LABEL: Record<string, string> = {
  pf: 'Pf の委託',
  ai: 'AI の委託',
  human: '人',
  unknown: '不明',
};

/** 名前・コードなど本文に地の文で載せる値。 */
export function plain(value: string): string {
  return escapeDiscord(redactValue(value.trim()));
}

/** 版・コマンドなどをコード表記で載せる値。 40 桁の SHA は 7 桁に縮める。 */
export function code(value: string): string {
  const shortened = shortenShas(value.trim());
  const safe = redactValue(shortened).replace(/`/g, "'");
  return safe ? `\`${safe}\`` : '—';
}

export function sha7(rev: string): string {
  return /^[0-9a-f]{7,40}$/i.test(rev) ? rev.slice(0, 7).toLowerCase() : '';
}

export function shortenShas(value: string): string {
  return value.replace(/\b[0-9a-f]{40}\b/gi, (sha) => sha.slice(0, 7).toLowerCase());
}

export function ownerLabel(owner: string): string {
  return OWNER_LABEL[owner] ?? (owner ? plain(owner) : '不明');
}

export function originLabel(origin: string | undefined, trigger: string): string {
  const base = ORIGIN_LABEL[origin ?? 'unknown'] ?? '不明';
  return origin === 'ai' && trigger.trim() ? `${base} (${plain(trigger)})` : base;
}

/** 依存の表示名。 コードがあれば添える (例: `Pictor (Pc)`)。 */
export function dependencyLabel(name: string, depCode: string): string {
  return depCode.trim() && depCode.trim() !== name.trim() ? `${plain(name)} (${plain(depCode)})` : plain(name);
}

/** pin の表記 (`v2.2.0 / 625d83d`)。 */
export function pinLabel(tag: string, rev: string): string {
  const parts = [tag.trim(), sha7(rev)].filter(Boolean);
  return parts.length > 0 ? code(parts.join(' / ')) : '—';
}
