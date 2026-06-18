/**
 * メモリ監視サブシステムの共通型。
 */

export type MemorySource = 'process' | 'docker' | 'metrics' | 'wsl';
export type MemoryTargetKind = 'service' | 'wsl';

/** 1 回のサンプリングで得た 1 ターゲット分の計測値 (store へ insert する前の形)。 */
export interface MemorySample {
  targetKind: MemoryTargetKind;
  /** service code | distro 名 | 'vmmem'。 */
  targetKey: string;
  /** target_kind='service' のとき紐付く instance。 wsl は null。 */
  serviceInstanceId: string | null;
  source: MemorySource;
  rssBytes: number | null;
  heapUsedBytes?: number | null;
  heapTotalBytes?: number | null;
  externalBytes?: number | null;
  arrayBuffersBytes?: number | null;
  pid?: number | null;
  detail?: Record<string, unknown>;
}

/** /metrics エンドポイントが返す process.memoryUsage() 相当 (Tier2 heap 内訳)。 */
export interface MemoryMetrics {
  rss?: number;
  heapUsed?: number;
  heapTotal?: number;
  external?: number;
  arrayBuffers?: number;
}
