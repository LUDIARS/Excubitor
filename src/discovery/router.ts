/**
 * 新規サービス候補を読み取り専用で検出する API (`/api/v1/discovery`)。
 *
 * - GET  /api/v1/discovery      : Ars の git repo を走査し catalog 未登録候補 + clone 欠落を返す。
 */

import { Hono } from 'hono';
import type { Catalog } from '../catalog/loader.js';
import { discoverServices, arsRoot, type DiscoveryResult } from './scan.js';
import { createNamedLogger } from '../shared/logger.js';
import { writeDiagnostic } from '../shared/diagnostic-log.js';
import { acquireRedisLock, deleteRedisKey, readRedisJson, redisCacheKey, writeRedisJson } from '../shared/redis-cache.js';

const DISCOVERY_CACHE_MS = readPositiveIntEnv('EXCUBITOR_DISCOVERY_CACHE_MS', 30_000);
const DISCOVERY_REDIS_REPOPULATE_MS = Math.min(DISCOVERY_CACHE_MS, 2_000);
const DISCOVERY_REDIS_TTL_MS = cacheStorageTtl(DISCOVERY_CACHE_MS);
const DISCOVERY_CACHE_KEY = redisCacheKey('discovery:v1');
const DISCOVERY_LOCK_KEY = `${DISCOVERY_CACHE_KEY}:refresh`;
const logger = createNamedLogger('excubitor.discovery.router');

interface DiscoveryCache {
  result: DiscoveryResult;
  capturedAt: number;
}

export function buildDiscoveryRouter(
  getCatalog: () => Catalog,
): Hono {
  const app = new Hono();
  let localFallback: DiscoveryCache | null = null;
  let pending: Promise<void> | null = null;
  let lastRedisPopulateAttempt = 0;

  function refresh(): void {
    if (pending) return;
    lastRedisPopulateAttempt = Date.now();
    pending = (async () => {
      const lock = await acquireRedisLock(DISCOVERY_LOCK_KEY, Math.max(DISCOVERY_CACHE_MS, 1_000));
      if (lock === false) return;
      const next = await discoverServices(getCatalog());
      const entry = { result: next, capturedAt: Date.now() };
      localFallback = entry;
      if (lock === true) await writeRedisJson(DISCOVERY_CACHE_KEY, entry, DISCOVERY_REDIS_TTL_MS);
    })()
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ err: message }, 'discovery refresh failed');
        writeDiagnostic('discovery.refresh.failed', { err: message });
      })
      .finally(() => {
        pending = null;
      });
  }

  async function discovery(): Promise<DiscoveryResult> {
    const now = Date.now();
    if (localFallback && now - localFallback.capturedAt < DISCOVERY_CACHE_MS) {
      return localFallback.result;
    }
    const cached = await readRedisJson<DiscoveryCache>(DISCOVERY_CACHE_KEY);
    if (cached) {
      const sourceStale = now - cached.capturedAt >= DISCOVERY_CACHE_MS;
      localFallback = { result: cached.result, capturedAt: now };
      if (sourceStale) refresh();
      return cached.result;
    }
    if (!localFallback) localFallback = { result: { candidates: [], missing: [], scannedRoot: arsRoot() }, capturedAt: 0 };
    if (
      now - localFallback.capturedAt >= DISCOVERY_CACHE_MS
      || now - lastRedisPopulateAttempt >= DISCOVERY_REDIS_REPOPULATE_MS
    ) refresh();
    return localFallback.result;
  }

  app.get('/api/v1/discovery', async (c) => {
    return c.json(await discovery());
  });

  refresh();
  return app;
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function cacheStorageTtl(freshMs: number): number {
  return Math.max(freshMs * 12, 60_000);
}
