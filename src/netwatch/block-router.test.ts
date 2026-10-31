/** @implements SPEC-EX-NETWATCH */
import { describe, expect, it } from 'vitest';
import { BlockRegistry } from './block-registry.js';
import { buildBlockRouter } from './block-router.js';
import { BlockService } from './block-service.js';
import { buildProtectionPolicy } from './block-target.js';

function app() {
  const writes: string[] = [];
  const service = new BlockService({
    registry: new BlockRegistry(),
    settings: () => ({
      settings: {
        file: 'blocks.json', statusFile: 'status.json', maxEntries: 10, defaultTtlMs: 3_600_000, maxTtlMs: 86_400_000,
        protection: buildProtectionPolicy([], [], []),
      },
      reason: null,
    }),
    syncStatus: () => null,
    persist: async (content) => { writes.push(content); },
    now: () => 0,
  });
  return { router: buildBlockRouter(service), writes };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) };
}

describe('buildBlockRouter', () => {
  it('POST で登録 (201)、 GET で一覧、 DELETE で解除', async () => {
    const { router } = app();
    const created = await router.request('/api/v1/netwatch/blocks', post(
      { kind: 'address', value: '203.0.113.5', reason: '不審な直接通信', ttl_minutes: 30 },
      { 'x-excubitor-actor': 'operator' },
    ));
    expect(created.status).toBe(201);
    const { block } = await created.json() as { block: { id: string; value: string; created_by: string; expires_at: string } };
    expect(block).toMatchObject({ value: '203.0.113.5/32', created_by: 'operator', expires_at: '1970-01-01T00:30:00.000Z' });
    const listed = await (await router.request('/api/v1/netwatch/blocks')).json() as { state: string; sync: unknown; blocks: Array<{ enforcement: string }> };
    expect(listed).toMatchObject({ state: 'ok', sync: null, blocks: [{ enforcement: 'pending' }] });
    expect((await router.request(`/api/v1/netwatch/blocks/${block.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await router.request(`/api/v1/netwatch/blocks/${block.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('不正な本文・知らない項目・守る範囲・不正な id は 400', async () => {
    const { router, writes } = app();
    expect((await router.request('/api/v1/netwatch/blocks', { method: 'POST', body: 'x' })).status).toBe(400);
    expect((await router.request('/api/v1/netwatch/blocks', post({ kind: 'allow', value: '203.0.113.5', reason: 'x' }))).status).toBe(400);
    expect((await router.request('/api/v1/netwatch/blocks', post({ kind: 'address', value: '203.0.113.5', reason: 'x', action: 'allow' }))).status).toBe(400);
    expect((await router.request('/api/v1/netwatch/blocks', post({ kind: 'address', value: '203.0.113.5', reason: ' ' }))).status).toBe(400);
    const lan = await router.request('/api/v1/netwatch/blocks', post({ kind: 'address', value: '192.168.0.1', reason: 'x' }));
    expect(lan.status).toBe(400);
    expect(await lan.json()).toMatchObject({ error: expect.stringMatching(/守る範囲/) });
    expect((await router.request('/api/v1/netwatch/blocks/not-an-id', { method: 'DELETE' })).status).toBe(400);
    expect(writes).toHaveLength(0);
  });

  it('同じ対象の二重登録は 409 で既存を返す', async () => {
    const { router } = app();
    await router.request('/api/v1/netwatch/blocks', post({ kind: 'address', value: '203.0.113.5', reason: 'x' }));
    const again = await router.request('/api/v1/netwatch/blocks', post({ kind: 'address', value: '203.0.113.5/32', reason: 'y' }));
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ existing: { value: '203.0.113.5/32', reason: 'x' } });
  });
});
