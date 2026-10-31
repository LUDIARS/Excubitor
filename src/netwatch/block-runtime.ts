/** @implements SPEC-EX-NETWATCH */
/**
 * 遮断 API の組み立て。 設定の確認 (と遮断ファイルの読み込み)・期限切れの除去・同期タスクの
 * 状態ファイルの読み取りを周期で行い、 API には BlockService を渡す。 状態は周期で読んでメモリに
 * 置き、 API の要求ごとにファイルを読まない。
 */

import { readFile, stat } from 'node:fs/promises';
import { createNamedLogger } from '../shared/logger.js';
import type { Catalog } from '../catalog/loader.js';
import { AtomicTextFile } from './atomic-text-file.js';
import { BlockRegistry } from './block-registry.js';
import { BlockService } from './block-service.js';
import { resolveBlockSettings, type BlockSettings } from './block-settings.js';
import { interpretSyncStatus, syncStatusError, type SyncStatus } from './firewall-sync-status.js';

const logger = createNamedLogger('excubitor.netwatch.block');
const RECONCILE_INTERVAL_MS = 30_000;
const STATUS_INTERVAL_MS = 15_000;
/** 同期タスクは 1 分ごとに動くので、 3 分書かれなければ止まっているとみなす。 */
const SYNC_STALE_AFTER_MS = 3 * 60_000;
const MAX_FILE_BYTES = 1024 * 1024;

export interface BlockingHandle {
  service: BlockService;
  stop: () => void;
}

export interface BlockingDeps {
  getCatalog: () => Catalog;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  platform?: NodeJS.Platform;
  now?: () => number;
  /** ファイルを読む。 無ければ null。 */
  readText?: (path: string) => Promise<string | null>;
  /** 希望状態を書く。 既定は一時ファイル + rename。 */
  writeText?: (path: string, content: string) => Promise<void>;
}

/** 大きすぎるファイルは読まない (壊れた・差し替えられたファイルでメモリを使い切らない)。 */
export async function readTextIfPresent(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    if (info.size > MAX_FILE_BYTES) throw new Error(`${MAX_FILE_BYTES} バイトを超えている`);
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function atomicWriter(): (path: string, content: string) => Promise<void> {
  const files = new Map<string, AtomicTextFile>();
  return async (path, content) => {
    const file = files.get(path) ?? new AtomicTextFile(path);
    files.set(path, file);
    await file.write(content);
  };
}

export function startNetwatchBlocking(deps: BlockingDeps): BlockingHandle {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const platform = deps.platform ?? process.platform;
  const now = deps.now ?? Date.now;
  const readText = deps.readText ?? readTextIfPresent;
  const writeText = deps.writeText ?? atomicWriter();

  let current: BlockSettings | null = null;
  let disabledReason: string | null = '読み込み中';
  /** 遮断ファイルを読み込み済みのパス。 読み終わるまで変更を受けない (空の状態で上書きしないため)。 */
  let loadedFile: string | null = null;
  let syncStatus: SyncStatus | null = null;

  const registry = new BlockRegistry();
  const service = new BlockService({
    registry,
    settings: () => current && loadedFile === current.file
      ? { settings: current, reason: null }
      : { settings: null, reason: disabledReason ?? '遮断ファイルの読み込み中' },
    syncStatus: () => syncStatus,
    persist: (content) => {
      if (!current) return Promise.reject(new Error('遮断は無効'));
      return writeText(current.file, content);
    },
    now,
  });

  const loadRegistry = async (file: string): Promise<void> => {
    try {
      registry.load(await readText(file));
    } catch (error) {
      registry.fail(`遮断ファイルを読めない: ${(error as Error).message}`);
      logger.warn({ err: (error as Error).message, file }, 'netwatch block: blocks file unreadable');
    }
    loadedFile = file;
  };

  const reconcile = async (): Promise<void> => {
    try {
      const resolved = resolveBlockSettings(deps.getCatalog(), {
        env, cwd, platform, ownPrograms: [process.execPath],
      });
      current = resolved.settings;
      disabledReason = resolved.disabledReason;
    } catch (error) {
      current = null;
      disabledReason = `設定が不正: ${(error as Error).message}`;
      return;
    }
    if (current && loadedFile !== current.file) await loadRegistry(current.file);
    if (current) await service.expire().catch((error: unknown) => {
      logger.warn({ err: (error as Error).message }, 'netwatch block: expiry write failed');
    });
  };

  const refreshStatus = async (): Promise<void> => {
    if (!current) {
      syncStatus = null;
      return;
    }
    try {
      syncStatus = interpretSyncStatus(await readText(current.statusFile), now(), SYNC_STALE_AFTER_MS);
    } catch (error) {
      syncStatus = syncStatusError(`状態ファイルを読めない: ${(error as Error).message}`);
    }
  };

  void reconcile().then(refreshStatus);
  const reconcileTimer = setInterval(() => { void reconcile(); }, RECONCILE_INTERVAL_MS);
  const statusTimer = setInterval(() => { void refreshStatus(); }, STATUS_INTERVAL_MS);
  reconcileTimer.unref();
  statusTimer.unref();

  return {
    service,
    stop: () => {
      clearInterval(reconcileTimer);
      clearInterval(statusTimer);
    },
  };
}
