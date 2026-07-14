import { describe, expect, it, vi } from 'vitest';
import { buildLogQueryRouter } from './query-router.js';

const validQuery = 'from=2026-01-01T00%3A00%3A00Z&to=2026-01-02T00%3A00%3A00Z';

describe('buildLogQueryRouter', () => {
  it('時刻範囲と上限を検証する', async () => {
    const router = buildLogQueryRouter({ execute: vi.fn(async () => []), logsRoot: () => 'unused' });
    expect((await router.request('/api/v1/logs/query')).status).toBe(400);
    expect((await router.request(`/api/v1/logs/query?${validQuery}&limit=5001`)).status).toBe(400);
    expect((await router.request('/api/v1/logs/query?from=bad&to=also-bad')).status).toBe(400);
  });

  it('同時実行 2 件を超えた要求を 429 にする', async () => {
    const releases: Array<() => void> = [];
    const execute = vi.fn(() => new Promise<never[]>((resolve) => releases.push(() => resolve([]))));
    const router = buildLogQueryRouter({ execute, logsRoot: () => 'unused' });
    const first = router.request(`/api/v1/logs/query?${validQuery}`);
    const second = router.request(`/api/v1/logs/query?${validQuery}`);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));

    expect((await router.request(`/api/v1/logs/query?${validQuery}`)).status).toBe(429);
    for (const release of releases) release();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
  });
});
