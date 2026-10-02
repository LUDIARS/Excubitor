#!/usr/bin/env node
// Infisical の全 project の値を Excubitor の Vault へ一括で移す (POST /api/v1/vault/import/infisical)。
//
//   node scripts/vault-import-infisical.mjs --url http://127.0.0.1:17332/ --dry-run   # 何が入るかだけ見る
//   node scripts/vault-import-infisical.mjs --url http://127.0.0.1:17332/             # 実際に登録する
//   [--environment dev]  サービスに紐付かない project で使う environment (既定 dev)
//
// Infisical の認証は Excubitor 本体の machine identity が行う。このスクリプトは資格情報を持たず、
// 値も表示しない (名前と件数だけ)。POST は再送しない。結果が不明なら Vault 画面で確かめてから再実行する。
import { parseArgs } from 'node:util';

try {
  const { values } = parseArgs({ options: {
    url: { type: 'string' }, environment: { type: 'string' },
    'dry-run': { type: 'boolean', default: false }, json: { type: 'boolean', default: false },
  }, strict: true, allowPositionals: false });
  if (!values.url) {
    throw new Error('Usage: node scripts/vault-import-infisical.mjs --url <local-Ex-URL> [--dry-run] [--environment <slug>] [--json]');
  }
  const base = new URL(values.url);
  if (base.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname)
      || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('Use the local Excubitor loopback HTTP origin (e.g. http://127.0.0.1:17332/)');
  }
  const body = { dry_run: values['dry-run'], ...(values.environment ? { environment: values.environment } : {}) };
  const statusResponse = await fetch(new URL('/api/v1/vault', base), { signal: AbortSignal.timeout(10_000) });
  const status = await statusResponse.json();
  if (!statusResponse.ok || !Array.isArray(status.projects)) {
    throw new Error('Excubitor does not support project Vaults yet. Update backend and supervisor before importing.');
  }
  const response = await fetch(new URL('/api/v1/vault/import/infisical', base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  });
  const result = await response.json();
  if (values.json || !response.ok) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write(formatSummary(result));
  }
  const failed = !response.ok || [...(result.services ?? []), ...(result.projects ?? [])].some((r) => r.error);
  if (failed) process.exitCode = 1;
} catch (error) {
  process.stderr.write(String(error.message) + '\nIf the POST may have reached Excubitor, check the Vault tab before running again.\n');
  process.exitCode = 1;
}

function formatSummary(result) {
  const lines = [result.dry_run ? '[dry-run] Vault は変更していません' : 'プロジェクト別Vaultに登録しました', ''];
  const row = (label, r) => {
    const state = r.error ? `失敗: ${r.error}` : r.skipped ? `skip: ${r.skipped}`
      : `新規 ${r.imported.length} / 同値 ${r.unchanged.length} / 衝突 ${r.conflicts.length} / 名前不可 ${r.invalid.length}`;
    lines.push(`  ${label}  ${state}`);
    if (r.conflicts.length) lines.push(`      衝突 (既にある別の値、取り込んでいない): ${r.conflicts.join(', ')}`);
    if (r.invalid.length) lines.push(`      名前不可 (取り込んでいない): ${r.invalid.join(', ')}`);
  };
  lines.push(`サービス (${result.services.length}) — 取り込み + 紐付け`);
  for (const r of result.services) row(`${r.code} [${r.environment}]`, r);
  lines.push('', `サービスに紐付かない project (${result.projects.length}) — 値だけ取り込み`);
  for (const r of result.projects) row(`${r.name} [${r.environment ?? '-'}]`, r);
  return lines.join('\n') + '\n';
}
