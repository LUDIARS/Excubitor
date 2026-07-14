/**
 * メモリサイズの parse / format ユーティリティ (pure)。
 *
 * docker stats は "123.4MiB / 7.5GiB" のような human-readable な単位文字列を返すため、
 * バイト数に正規化する。 表示用の formatBytes も提供する。
 */

const UNIT_FACTORS: Record<string, number> = {
  b: 1,
  kb: 1000,
  kib: 1024,
  mb: 1000 ** 2,
  mib: 1024 ** 2,
  gb: 1000 ** 3,
  gib: 1024 ** 3,
  tb: 1000 ** 4,
  tib: 1024 ** 4,
};

/**
 * "123.4MiB" / "7.5GiB" / "512B" / "1.2kB" などをバイト数へ。 解釈不能なら null。
 * docker は MiB/GiB (binary) が既定だが kB/MB (decimal) や B も来うるため両対応。
 */
export function parseSize(input: string): number | null {
  const m = input.trim().match(/^([0-9]*\.?[0-9]+)\s*([a-zA-Z]+)$/);
  if (!m) return null;
  const value = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  const factor = UNIT_FACTORS[unit];
  if (!isFinite(value) || factor === undefined) return null;
  return Math.round(value * factor);
}

/** バイト数を表示用文字列へ (MiB/GiB、 小数1桁)。 null は "—"。 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const mib = bytes / (1024 ** 2);
  if (mib < 1024) return `${mib.toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}
