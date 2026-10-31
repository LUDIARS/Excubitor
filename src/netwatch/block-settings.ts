/** @implements SPEC-EX-NETWATCH */
/**
 * config の `netwatch.block` と拠点の環境から、 遮断 API の設定を決める。
 * Windows 以外・%ProgramData% の無い環境では理由を返し、 別の場所を探しに行かない。
 */

import { join, resolve } from 'node:path';
import type { Catalog } from '../catalog/loader.js';
import { buildProtectionPolicy, type ProtectionPolicy } from './block-target.js';

export interface BlockSettings {
  /** 遮断の希望状態ファイル (絶対パス)。 */
  file: string;
  /** 同期タスクの状態ファイル (絶対パス)。 */
  statusFile: string;
  maxEntries: number;
  defaultTtlMs: number;
  maxTtlMs: number;
  protection: ProtectionPolicy;
}

export type ResolvedBlockSettings =
  | { settings: BlockSettings; disabledReason: null }
  | { settings: null; disabledReason: string };

export interface BlockEnvironment {
  env: NodeJS.ProcessEnv;
  cwd: string;
  platform: NodeJS.Platform;
  /** Excubitor 自身の実行ファイル (止めない)。 */
  ownPrograms: readonly string[];
}

/** 同期タスクが状態を書く既定の場所 (scripts/install-netwatch-firewall.ps1 と同じ)。 */
export function defaultStatusFile(programData: string): string {
  return join(programData, 'Excubitor', 'netwatch-firewall', 'status.json');
}

export function resolveBlockSettings(catalog: Catalog, environment: BlockEnvironment): ResolvedBlockSettings {
  const config = catalog.netwatch.block;
  if (!config.enabled) return { settings: null, disabledReason: 'netwatch.block.enabled=false' };
  if (environment.platform !== 'win32') return { settings: null, disabledReason: '遮断は Windows ファイアウォールだけ (Windows 以外は使えない)' };
  let statusFile = config.status_file.trim();
  if (!statusFile) {
    // Windows の process.env は名前の大小を区別しない。
    const programData = environment.env.ProgramData?.trim() ?? '';
    if (!programData) return { settings: null, disabledReason: 'ProgramData の環境変数が無く、 同期タスクの状態ファイルの場所が決まらない' };
    statusFile = defaultStatusFile(programData);
  }
  if (config.default_ttl_min > config.max_ttl_min) {
    throw new Error('netwatch.block.default_ttl_min が max_ttl_min より大きい');
  }
  return {
    settings: {
      file: resolve(environment.cwd, config.file),
      statusFile: resolve(environment.cwd, statusFile),
      maxEntries: config.max_entries,
      defaultTtlMs: config.default_ttl_min * 60_000,
      maxTtlMs: config.max_ttl_min * 60_000,
      protection: buildProtectionPolicy(config.protected_addresses, config.protected_programs, environment.ownPrograms),
    },
    disabledReason: null,
  };
}
