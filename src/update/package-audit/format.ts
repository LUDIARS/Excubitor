/**
 * 監査レポートを人間向けテキストと Discord メッセージ列へ整形する。
 *
 * @implements SPEC-PACKAGE-UPDATE-AUDIT
 */

import type { PackageAuditReport, PackageUpdate, PackageVulnerability } from './types.js';

const CATEGORY_LABEL = {
  safe: '安全',
  major: 'メジャー/破壊的',
  native: 'ネイティブ/再ビルド要',
} as const;

const DISCORD_MESSAGE_LIMIT = 1_900;

export function formatPackageAuditText(report: PackageAuditReport): string {
  return reportLines(report).join('\n');
}

export function formatPackageAuditDiscordMessages(report: PackageAuditReport): string[] {
  const messages: string[] = [];
  let current = '';
  for (const unsplitBlock of reportBlocks(report)) {
    for (const block of splitDiscordBlock(unsplitBlock)) {
      if (!current) {
        current = block;
        continue;
      }
      if (`${current}\n\n${block}`.length <= DISCORD_MESSAGE_LIMIT) {
        current = `${current}\n\n${block}`;
      } else {
        messages.push(current);
        current = block;
      }
    }
  }
  if (current) messages.push(current);
  return messages;
}

function splitDiscordBlock(block: string): string[] {
  const chunks: string[] = [];
  let remaining = block;
  while (remaining.length > DISCORD_MESSAGE_LIMIT) {
    let splitAt = remaining.lastIndexOf('\n', DISCORD_MESSAGE_LIMIT + 1);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(' ', DISCORD_MESSAGE_LIMIT + 1);
    if (splitAt <= 0) splitAt = DISCORD_MESSAGE_LIMIT;
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function reportLines(report: PackageAuditReport): string[] {
  return reportBlocks(report).flatMap((block, index) => index === 0 ? [block] : ['', block]);
}

function reportBlocks(report: PackageAuditReport): string[] {
  const blocks = [
    [
      `📦 **Excubitor パッケージ日次監査 — ${report.capturedAt.slice(0, 10)}**`,
      `更新 ${report.summary.total}件（安全 ${report.summary.safe} / メジャー ${report.summary.major} / ネイティブ ${report.summary.native}）`,
      `脆弱性 ${report.summary.vulnerabilities}件 / 対象リポ ${report.summary.localTargets} / グローバル ${report.summary.globalPackages} packages`,
    ].join('\n'),
  ];

  if (report.updates.length === 0) {
    blocks.push('✅ パッケージ更新はありません。');
  } else {
    blocks.push('**更新一覧**');
    for (const update of report.updates) blocks.push(updateBlock(update));
  }

  if (report.vulnerabilities.length === 0) {
    blocks.push('✅ npm audit の脆弱性アラートはありません。');
  } else {
    blocks.push('**脆弱性アラート**');
    for (const vulnerability of report.vulnerabilities) {
      blocks.push(vulnerabilityBlock(vulnerability));
    }
  }

  const coverageGaps = report.issues.filter((entry) => entry.code === 'npm_audit_lock_missing');
  if (coverageGaps.length > 0) {
    blocks.push([
      `**npm audit 未実施 (${coverageGaps.length})**`,
      ...coverageGaps.map((entry) => (
        `• ${escapeDiscord(entry.target)} — ${truncate(entry.message, 180)}`
      )),
    ].join('\n'));
  }

  const importantIssues = report.issues.filter((entry) => entry.code !== 'npm_audit_lock_missing');
  if (importantIssues.length > 0) {
    const shown = importantIssues.slice(0, 12);
    blocks.push([
      `**監査上の注意 (${importantIssues.length})**`,
      ...shown.map((entry) => (
        `• ${escapeDiscord(entry.target)}: ${entry.code} — ${truncate(entry.message, 180)}`
      )),
      ...(shown.length < importantIssues.length ? [`• ほか ${importantIssues.length - shown.length}件`] : []),
    ].join('\n'));
  }
  return blocks;
}

function updateBlock(update: PackageUpdate): string {
  const current = update.current ?? '未導入';
  const wanted = update.wanted && update.wanted !== update.latest
    ? `（レンジ内 ${update.wanted}）`
    : '';
  const notes = update.releaseNotes
    ? truncate(update.releaseNotes, 420)
    : 'リリースノート未取得';
  const lines = [
    `• **${escapeDiscord(update.packageName)}** ${current} → ${update.latest}${wanted} [${CATEGORY_LABEL[update.category]}]`,
    `  使用: ${update.projects.map(escapeDiscord).join(', ')}`,
    `  更新内容: ${notes}`,
  ];
  if (update.releaseUrl) lines.push(`  ${update.releaseUrl}`);
  return lines.join('\n');
}

function vulnerabilityBlock(vulnerability: PackageVulnerability): string {
  const fix = vulnerability.fixVersion
    ? `${vulnerability.fixVersion}${vulnerability.isBreakingFix ? ' (major)' : ''}`
    : '自動修正なし';
  const lines = [
    `• **${escapeDiscord(vulnerability.packageName)}** [${vulnerability.severity}] range ${vulnerability.range}`,
    `  使用: ${vulnerability.projects.map(escapeDiscord).join(', ')} / fix: ${fix}`,
  ];
  const title = vulnerability.advisoryTitles[0];
  const url = vulnerability.advisoryUrls[0];
  if (title) lines.push(`  ${truncate(title, 240)}`);
  if (url) lines.push(`  ${url}`);
  return lines.join('\n');
}

function escapeDiscord(value: string): string {
  return value.replace(/([\\`*_{}\[\]()<>#+\-.!|])/g, '\\$1');
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3))}...`;
}
