/**
 * アップデート API (`/api/v1/updates` + `/api/v1/services/:code/update`)。
 *
 * - GET  /api/v1/updates?fetch=1        全サービスのアップデート状態 (fetch=1 で origin 取得)
 * - GET  /api/v1/services/:code/update  単一サービスの状態 (常に fetch)
 * - POST /api/v1/services/:code/update  アップデート適用 (pull + install + restart)
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { Catalog } from '../catalog/loader.js';
import { createNamedLogger } from '../shared/logger.js';
import { writeDiagnostic } from '../shared/diagnostic-log.js';
import { acquireRedisLock, readRedisJson, redisCacheKey, writeRedisJson } from '../shared/redis-cache.js';
import { checkAllUpdates, checkUpdate, recentCommits, branchStatus, repoDirOf, type UpdateStatus } from './checker.js';
import { applyUpdate } from './apply.js';

const UPDATE_CACHE_MS = readPositiveIntEnv('EXCUBITOR_UPDATE_CACHE_MS', 60_000);
const UPDATE_REDIS_REPOPULATE_MS = Math.min(UPDATE_CACHE_MS, 2_000);
const UPDATE_REDIS_TTL_MS = cacheStorageTtl(UPDATE_CACHE_MS);
const UPDATE_CACHE_KEY = redisCacheKey('updates:v1');
const UPDATE_LOCK_KEY = `${UPDATE_CACHE_KEY}:refresh`;
const logger = createNamedLogger('excubitor.update.router');

interface UpdateCache {
  updates: UpdateStatus[];
  fetched: boolean;
  capturedAt: number;
}

const ApplyBodySchema = z.object({
  install: z.boolean().optional(),
  restart: z.boolean().optional(),
});

export function buildUpdateRouter(getCatalog: () => Catalog): Hono {
  const app = new Hono();
  let localFallback: UpdateCache | null = null;
  let pending: Promise<void> | null = null;
  let lastRedisPopulateAttempt = 0;

  function refresh(fetch: boolean): void {
    if (pending) return;
    lastRedisPopulateAttempt = Date.now();
    pending = (async () => {
      const lock = await acquireRedisLock(UPDATE_LOCK_KEY, Math.max(UPDATE_CACHE_MS, 1_000));
      if (lock === false) return;
      const updates = await checkAllUpdates(getCatalog(), fetch);
      const entry = { updates, fetched: fetch, capturedAt: Date.now() };
      localFallback = entry;
      if (lock === true) await writeRedisJson(UPDATE_CACHE_KEY, entry, UPDATE_REDIS_TTL_MS);
    })()
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ err: message, fetch }, 'update status refresh failed');
        writeDiagnostic('updates.refresh.failed', { err: message, fetch });
      })
      .finally(() => {
        pending = null;
      });
  }

  async function snapshot(fetch: boolean): Promise<{ updates: UpdateStatus[]; fetched: boolean; refreshing: boolean }> {
    const now = Date.now();
    if (localFallback && now - localFallback.capturedAt < UPDATE_CACHE_MS) {
      if (fetch && !localFallback.fetched) refresh(true);
      return { updates: localFallback.updates, fetched: localFallback.fetched, refreshing: pending !== null };
    }
    const cached = await readRedisJson<UpdateCache>(UPDATE_CACHE_KEY);
    if (cached) {
      const sourceStale = now - cached.capturedAt >= UPDATE_CACHE_MS;
      localFallback = { updates: cached.updates, fetched: cached.fetched, capturedAt: now };
      if (fetch || sourceStale) refresh(fetch);
      return { updates: cached.updates, fetched: cached.fetched, refreshing: pending !== null };
    }
    if (!localFallback) localFallback = { updates: placeholderUpdates(getCatalog()), fetched: false, capturedAt: 0 };
    if (
      fetch
      || now - localFallback.capturedAt >= UPDATE_CACHE_MS
      || now - lastRedisPopulateAttempt >= UPDATE_REDIS_REPOPULATE_MS
    ) refresh(fetch);
    return { updates: localFallback.updates, fetched: localFallback.fetched, refreshing: pending !== null };
  }

  app.get('/api/v1/updates', async (c) => {
    const fetch = c.req.query('fetch') === '1';
    return c.json(await snapshot(fetch));
  });

  // カード「最近の更新内容」用: サービスリポの直近コミット。
  app.get('/api/v1/services/:code/commits', async (c) => {
    const code = c.req.param('code');
    const svc = getCatalog().services.find((s) => s.code === code);
    if (!svc) return c.json({ error: 'not_found' }, 404);
    const limitRaw = Number(c.req.query('limit') ?? 5);
    const limit = Math.max(1, Math.min(50, isFinite(limitRaw) ? limitRaw : 5));
    const commits = await recentCommits(svc, limit);
    return c.json({ code, commits });
  });

  // ブランチ状況: 現在ブランチ / ローカル+リモート一覧 / ahead-behind / dirty。
  app.get('/api/v1/services/:code/branches', async (c) => {
    const code = c.req.param('code');
    const svc = getCatalog().services.find((s) => s.code === code);
    if (!svc) return c.json({ error: 'not_found' }, 404);
    return c.json(await branchStatus(svc));
  });

  app.get('/api/v1/services/:code/update', async (c) => {
    const code = c.req.param('code');
    const svc = getCatalog().services.find((s) => s.code === code);
    if (!svc) return c.json({ error: 'not_found' }, 404);
    const status = await checkUpdate(svc, true);
    return c.json(status);
  });

  app.post('/api/v1/services/:code/update', async (c) => {
    const code = c.req.param('code');
    const svc = getCatalog().services.find((s) => s.code === code);
    if (!svc) return c.json({ error: 'not_found' }, 404);
    const body = await c.req.json().catch(() => ({}));
    const parsed = ApplyBodySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
    const actor = c.req.header('x-excubitor-actor') ?? 'launcher';
    const result = await applyUpdate(svc, actor, parsed.data);
    return c.json(result, result.ok ? 200 : 400);
  });

  refresh(false);
  return app;
}

function placeholderUpdates(catalog: Catalog): UpdateStatus[] {
  return catalog.services.map((svc) => ({
    code: svc.code,
    repoDir: repoDirOf(svc),
    branch: null,
    behind: 0,
    ahead: 0,
    dirty: false,
    available: false,
    note: 'refreshing',
    fetched: false,
  }));
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
