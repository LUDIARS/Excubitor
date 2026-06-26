/**
 * 起動セットの一括 起動 / 停止 指揮。
 *
 * - preflight で前提を確認 (NG のサービスは skip)
 * - order.ts の tier 順に control を呼ぶ (infra → Cernere → Corpus → leaf)
 * - tier 間にだけ待ちを入れて、 依存基盤が上がってから leaf を起こす
 *
 * env の Infisical relay は controlService → resolveInjectEnv が行う (orchestrator は関与しない)。
 */

import { createNamedLogger } from '../shared/logger.js';
import type { Catalog } from '../catalog/loader.js';
import { controlService } from '../control/manager.js';
import { orderForStart, orderForStop } from './order.js';
import { runPreflight, type PreflightReport } from './preflight.js';
import { withCorpusIfNeeded } from './corpus-prefs.js';

const logger = createNamedLogger('excubitor.launch');

const TIER_GAP_MS = 1500;

export interface LaunchItemResult {
  code: string;
  ok: boolean;
  skipped: boolean;
  message: string;
}

export interface LaunchResult {
  preflight: PreflightReport;
  results: LaunchItemResult[];
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface StartOptions {
  /** preflight で ready でないサービスを起動対象から外す (default true)。 */
  skipNotReady?: boolean;
  actor?: string;
}

export async function startSelection(
  catalog: Catalog,
  codes: string[],
  opts: StartOptions = {},
): Promise<LaunchResult> {
  const skipNotReady = opts.skipNotReady ?? true;
  const actor = opts.actor ?? 'launcher';

  // Corpus を使うサービスが含まれていれば Corpus も起動セットに加える (tier 順で先に上がる)。
  codes = withCorpusIfNeeded(catalog, codes);

  const preflight = await runPreflight(catalog.services, codes);
  const notReady = new Set(
    skipNotReady ? preflight.services.filter((s) => !s.ready).map((s) => s.code) : [],
  );

  const tiers = orderForStart(catalog.services, codes);
  const results: LaunchItemResult[] = [];

  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i]!;
    for (const svc of tier.services) {
      if (notReady.has(svc.code)) {
        results.push({ code: svc.code, ok: false, skipped: true, message: 'preflight not ready' });
        continue;
      }
      try {
        const r = await controlService(svc, 'start', actor);
        results.push({ code: svc.code, ok: r.ok, skipped: false, message: r.ok ? r.stdout : r.stderr });
      } catch (err) {
        results.push({ code: svc.code, ok: false, skipped: false, message: (err as Error).message });
      }
    }
    if (i < tiers.length - 1) await delay(TIER_GAP_MS);
  }

  logger.info(
    { started: results.filter((r) => r.ok).length, skipped: results.filter((r) => r.skipped).length },
    'startSelection complete',
  );
  return { preflight, results };
}

export async function stopSelection(catalog: Catalog, codes: string[], actor = 'launcher'): Promise<LaunchItemResult[]> {
  const ordered = orderForStop(catalog.services, codes);
  const results: LaunchItemResult[] = [];
  for (const svc of ordered) {
    try {
      const r = await controlService(svc, 'stop', actor);
      results.push({ code: svc.code, ok: r.ok, skipped: false, message: r.ok ? r.stdout : r.stderr });
    } catch (err) {
      results.push({ code: svc.code, ok: false, skipped: false, message: (err as Error).message });
    }
  }
  return results;
}
