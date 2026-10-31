/** @implements SPEC-EX-NETWATCH */
/**
 * config (全拠点共有の方針) と拠点の env から、 この拠点で動かす通信監視の設定を決める。
 * キャプチャしない理由は reason として返し、 別のインタフェースや別の tshark を探しに行かない。
 */

import { resolve } from 'node:path';
import type { Catalog } from '../catalog/loader.js';
import { buildTsharkArgs, DEFAULT_CAPTURE_FILTER } from './tshark-command.js';

export const NETWATCH_INTERFACE_ENV = 'EXCUBITOR_NETWATCH_INTERFACE';
export const NETWATCH_TSHARK_ENV = 'EXCUBITOR_NETWATCH_TSHARK';

export interface CaptureSettings {
  executable: string;
  args: string[];
  homeCountry: string;
  maxDestinations: number;
  dnsTtlMs: number;
  restartAfterMs: number;
  retryAfterMs: number;
  /** 同じ値なら起動し直さない比較用。 */
  fingerprint: string;
}

export interface OverlaySettings {
  /** 絶対パス。 null なら書かない。 */
  file: string | null;
  maxRows: number;
  include: 'foreign' | 'public';
  intervalMs: number;
}

export interface DetectSettings {
  /** 接続表を読む周期。 0 なら送信元プロセスを特定しない。 */
  ownerPollMs: number;
  allowedPorts: ReadonlySet<number>;
  /** 小文字・末尾ドットなし。 */
  trustedDomains: string[];
}

export type ResolvedSettings =
  | { capture: CaptureSettings; disabledReason: null; overlay: OverlaySettings; detect: DetectSettings }
  | { capture: null; disabledReason: string; overlay: OverlaySettings; detect: DetectSettings };

export function resolveNetwatchSettings(
  catalog: Catalog,
  env: NodeJS.ProcessEnv,
  cwd: string,
): ResolvedSettings {
  const config = catalog.netwatch;
  const overlay: OverlaySettings = {
    file: config.overlay.file.trim() ? resolve(cwd, config.overlay.file) : null,
    maxRows: config.overlay.max_rows,
    include: config.overlay.include,
    intervalMs: config.overlay.interval_sec * 1000,
  };
  const detect: DetectSettings = {
    ownerPollMs: config.detect.owner_poll_sec * 1000,
    allowedPorts: new Set(config.detect.allowed_ports),
    trustedDomains: config.detect.trusted_domains.map((domain) => domain.trim().toLowerCase().replace(/\.$/, '')).filter(Boolean),
  };
  if (!config.enabled) return { capture: null, disabledReason: 'netwatch.enabled=false', overlay, detect };
  const captureInterface = env[NETWATCH_INTERFACE_ENV]?.trim() ?? '';
  if (!captureInterface) return { capture: null, disabledReason: `${NETWATCH_INTERFACE_ENV} 未設定`, overlay, detect };
  const executable = env[NETWATCH_TSHARK_ENV]?.trim() || 'tshark';
  const args = buildTsharkArgs({
    interface: captureInterface,
    captureFilter: config.capture_filter.trim() || DEFAULT_CAPTURE_FILTER,
    nameResolution: config.name_resolution.trim(),
  });
  const capture: CaptureSettings = {
    executable,
    args,
    homeCountry: config.home_country,
    maxDestinations: config.max_destinations,
    dnsTtlMs: config.dns_ttl_sec * 1000,
    restartAfterMs: config.restart_after_min * 60_000,
    retryAfterMs: config.retry_after_sec * 1000,
    fingerprint: JSON.stringify([executable, args]),
  };
  return { capture, disabledReason: null, overlay, detect };
}
