/**
 * リポジトリ解析 → カタログ自動生成。
 *
 * Ars ワークスペースの「catalog 未登録だが実行可能なアプリを持つ」 repo を検出し、
 * runtime / 起動コマンド / 使用ポートを推定して catalog エントリを自動生成する。
 * 生成先は services.auto.yaml (手書き services.yaml は壊さない)。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createNamedLogger } from '../shared/logger.js';
import { safeExec } from '../shared/exec.js';
import type { Catalog } from './loader.js';
import { discoverServices, type DiscoveredRepo } from '../discovery/scan.js';
import { readAutoCatalogRaw, writeAutoServices } from './auto-catalog-file.js';

const logger = createNamedLogger('excubitor.auto-catalog');

/** 生成する catalog エントリ (ServiceSchema のサブセット、 plain object)。 */
export interface GeneratedService {
  code: string;
  name: string;
  project_code: string;
  runtime: 'node' | 'docker-compose';
  repo?: string;
  cwd?: string;
  command?: string;
  compose_file?: string;
  port?: number;
  autostart: boolean;
  monitor_only: boolean;
}

interface PackageJson {
  scripts?: Record<string, string>;
}

/** repo 名から catalog code を作る (小文字 + [a-z0-9-] 以外を - に畳む)。 */
export function toCode(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

/** 文字列から最初の妥当なポート番号 (2-5 桁、 1-65535) を拾う (pure)。 */
export function extractPort(text: string): number | null {
  const patterns = [
    /(?:--port|-p)[\s=]+(\d{2,5})/i,
    /\bPORT\b\s*[=:]\s*(\d{2,5})/,
    /\bport\s*:\s*(\d{2,5})/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const n = Number(m[1]);
      if (n >= 1 && n <= 65535) return n;
    }
  }
  return null;
}

/** repo 内の典型的な場所からポートを検出する。 見つからなければ null。 */
function detectPort(repoPath: string, pkg: PackageJson | null): number | null {
  // 1) package.json の dev / start スクリプト
  const scriptText = [pkg?.scripts?.['dev'], pkg?.scripts?.['start'], pkg?.scripts?.['dev:server']]
    .filter(Boolean).join('\n');
  const fromScript = extractPort(scriptText);
  if (fromScript) return fromScript;

  // 2) .env / .env.local の *PORT=
  for (const f of ['.env', '.env.local']) {
    const p = join(repoPath, f);
    if (!existsSync(p)) continue;
    try {
      const m = readFileSync(p, 'utf8').match(/^[ \t]*[A-Z0-9_]*PORT\s*=\s*(\d{2,5})/m);
      if (m) {
        const n = Number(m[1]);
        if (n >= 1 && n <= 65535) return n;
      }
    } catch { /* ignore */ }
  }

  // 3) vite.config.* の server.port / port
  for (const f of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.mts']) {
    const p = join(repoPath, f);
    if (!existsSync(p)) continue;
    try {
      const found = extractPort(readFileSync(p, 'utf8'));
      if (found) return found;
    } catch { /* ignore */ }
  }
  return null;
}

function readPkg(repoPath: string): PackageJson | null {
  const p = join(repoPath, 'package.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as PackageJson;
  } catch {
    return null;
  }
}

function composeFileOf(repoPath: string): string | null {
  for (const f of ['docker-compose.yaml', 'docker-compose.yml']) {
    const p = join(repoPath, f);
    if (existsSync(p)) return p.replace(/\\/g, '/');
  }
  return null;
}

/**
 * 1 repo を解析して catalog エントリを生成する。 実行可能なアプリでなければ null
 * (= ライブラリ等。 dev/start スクリプトも compose も無い)。
 */
export function analyzeRepo(repo: DiscoveredRepo): GeneratedService | null {
  const pkg = readPkg(repo.path);
  const code = toCode(repo.name);
  if (!code) return null;
  if (code === 'excubitor') return null;

  const base = {
    code,
    name: repo.name,
    project_code: code,
    repo: repo.remote ?? undefined,
    autostart: false,
    monitor_only: false,
  };

  const compose = composeFileOf(repo.path);
  if (compose) {
    const port = detectPort(repo.path, pkg);
    return { ...base, runtime: 'docker-compose', compose_file: compose, ...(port ? { port } : {}) };
  }

  const dev = pkg?.scripts?.['dev'] ?? pkg?.scripts?.['dev:server'];
  const start = pkg?.scripts?.['start'];
  const command = dev ? 'npm run dev' : start ? 'npm start' : null;
  if (!command) return null; // 実行可能アプリでない (ライブラリ等)

  const port = detectPort(repo.path, pkg);
  return { ...base, runtime: 'node', cwd: repo.path, command, ...(port ? { port } : {}) };
}

export interface ScanResult {
  created: string[];
  /** code → 検出したポート。 */
  ports: Record<string, number>;
  /** 実行可能アプリでないため見送った候補。 */
  skipped: Array<{ name: string; reason: string }>;
  scannedRoot: string;
}

/**
 * 未登録 repo を解析し、 実行可能なものを services.auto.yaml に自動生成する。
 * catalog に既存 (手書き含む) の code は触らない。 既存の auto エントリは再生成で更新。
 */
export async function runScan(catalog: Catalog): Promise<ScanResult> {
  const discovery = await discoverServices(catalog);
  const existingCodes = new Set(catalog.services.map((s) => s.code));
  const autoCatalog = readAutoCatalogRaw();
  const ignoredCodes = new Set(autoCatalog.ignored_codes);

  // 既存 auto を code→entry で持ち、 新規/更新をマージする。
  const merged = new Map<string, GeneratedService>();
  for (const e of autoCatalog.services) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && ignoredCodes.has(code)) continue;
    if (typeof code === 'string') merged.set(code, e as GeneratedService);
  }

  const created: string[] = [];
  const ports: Record<string, number> = {};
  const skipped: Array<{ name: string; reason: string }> = [];

  for (const cand of discovery.candidates) {
    const entry = analyzeRepo(cand);
    if (!entry) {
      skipped.push({ name: cand.name, reason: '実行可能アプリ未検出 (dev/start/compose なし)' });
      continue;
    }
    if (ignoredCodes.has(entry.code)) {
      skipped.push({ name: cand.name, reason: `ignored code (${entry.code})` });
      continue;
    }
    // 手書きカタログに既にある code は侵さない (auto に無い新規 code のみ採用)。
    if (existingCodes.has(entry.code) && !merged.has(entry.code)) {
      skipped.push({ name: cand.name, reason: `code 衝突 (${entry.code} は既登録)` });
      continue;
    }
    const isNew = !merged.has(entry.code);
    merged.set(entry.code, entry);
    if (isNew) created.push(entry.code);
    if (entry.port) ports[entry.code] = entry.port;
  }

  writeAutoServices(Array.from(merged.values()), autoCatalog.ignored_codes);
  logger.info({ created: created.length, ports: Object.keys(ports).length, skipped: skipped.length }, 'scan auto-catalog complete');
  return { created, ports, skipped, scannedRoot: discovery.scannedRoot };
}
