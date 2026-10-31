/** @implements SPEC-EX-NETWATCH */
import { describe, expect, it } from 'vitest';
import { BLOCKS_FILE_FORMAT, BlockRegistry } from './block-registry.js';
import { BlockService } from './block-service.js';
import type { BlockSettings } from './block-settings.js';
import { buildProtectionPolicy } from './block-target.js';
import { interpretSyncStatus, SYNC_STATUS_FORMAT, type SyncStatus } from './firewall-sync-status.js';

const settings: BlockSettings = {
  file: 'C:\\ex\\data\\netwatch\\firewall-blocks.json',
  statusFile: 'C:\\ProgramData\\Excubitor\\netwatch-firewall\\status.json',
  maxEntries: 2,
  defaultTtlMs: 60 * 60_000,
  maxTtlMs: 24 * 60 * 60_000,
  protection: buildProtectionPolicy([], [], []),
};

function setup(options: { failWrite?: boolean; disabled?: string; sync?: SyncStatus | null } = {}) {
  let nowMs = 1_000_000;
  const writes: string[] = [];
  const registry = new BlockRegistry();
  const service = new BlockService({
    registry,
    settings: () => options.disabled ? { settings: null, reason: options.disabled } : { settings, reason: null },
    syncStatus: () => options.sync ?? null,
    persist: async (content) => {
      if (options.failWrite) throw new Error('disk full');
      writes.push(content);
    },
    now: () => nowMs,
  });
  return { registry, service, writes, advance: (ms: number) => { nowMs += ms; } };
}

describe('BlockService', () => {
  it('検証した対象を登録してファイルへ書き、 同じ対象の二重登録と上限超えは 409', async () => {
    const { service, writes } = setup();
    const added = await service.add({ kind: 'address', value: '203.0.113.5', reason: '不審', actor: 'tester' });
    expect(added).toMatchObject({ ok: true, value: { kind: 'address', value: '203.0.113.5/32', createdBy: 'tester' } });
    const written = JSON.parse(writes.at(-1)!);
    expect(written).toMatchObject({ format: BLOCKS_FILE_FORMAT, version: 1, blocks: [{ value: '203.0.113.5/32', reason: '不審' }] });
    expect(await service.add({ kind: 'address', value: '203.0.113.5/32', reason: 'x', actor: 'a' })).toMatchObject({ ok: false, status: 409 });
    await service.add({ kind: 'program', value: 'C:\\Tools\\a.exe', reason: 'x', actor: 'a' });
    expect(await service.add({ kind: 'address', value: '198.51.100.9', reason: 'x', actor: 'a' })).toMatchObject({ ok: false, status: 409 });
  });

  it('守る範囲・不正な期限は 400、 無効なら 503', async () => {
    const { service, writes } = setup();
    expect(await service.add({ kind: 'address', value: '192.168.1.1', reason: 'x', actor: 'a' })).toMatchObject({ ok: false, status: 400 });
    expect(await service.add({ kind: 'address', value: '203.0.113.5', reason: 'x', ttlMinutes: 24 * 60 + 1, actor: 'a' }))
      .toMatchObject({ ok: false, status: 400 });
    expect(writes).toHaveLength(0);
    const disabled = setup({ disabled: '遮断は Windows ファイアウォールだけ' });
    expect(await disabled.service.add({ kind: 'address', value: '203.0.113.5', reason: 'x', actor: 'a' }))
      .toMatchObject({ ok: false, status: 503, error: '遮断は Windows ファイアウォールだけ' });
  });

  it('書けなければ巻き戻して 503', async () => {
    const { service, registry } = setup({ failWrite: true });
    expect(await service.add({ kind: 'address', value: '203.0.113.5', reason: 'x', actor: 'a' })).toMatchObject({ ok: false, status: 503 });
    expect(registry.list(0)).toEqual([]);
  });

  it('解除と期限切れはファイルから外す。 無い id は 404', async () => {
    const { service, writes, advance } = setup();
    const first = await service.add({ kind: 'address', value: '203.0.113.5', reason: 'x', ttlMinutes: 1, actor: 'a' });
    const second = await service.add({ kind: 'address', value: '203.0.113.6', reason: 'x', actor: 'a' });
    if (!first.ok || !second.ok) throw new Error('setup');
    expect(await service.remove('00000000-0000-4000-8000-000000000000')).toMatchObject({ ok: false, status: 404 });
    advance(61_000);
    await service.expire();
    expect(JSON.parse(writes.at(-1)!).blocks.map((block: { id: string }) => block.id)).toEqual([second.value.id]);
    expect(await service.remove(second.value.id)).toMatchObject({ ok: true });
    expect(JSON.parse(writes.at(-1)!).blocks).toEqual([]);
  });

  it('壊れた遮断ファイルを読んだら変更を受けず、 上書きしない', async () => {
    const { service, registry, writes } = setup();
    registry.load('{"format":"other"}');
    expect(service.overview()).toMatchObject({ state: 'failed' });
    expect(await service.add({ kind: 'address', value: '203.0.113.5', reason: 'x', actor: 'a' })).toMatchObject({ ok: false, status: 503 });
    expect(writes).toHaveLength(0);
  });

  it('一覧に同期タスクの反映状況を付ける', async () => {
    const { service, registry } = setup();
    await service.add({ kind: 'address', value: '203.0.113.5', reason: 'x', actor: 'a' });
    await service.add({ kind: 'address', value: '203.0.113.6', reason: 'x', actor: 'a' });
    const [first, second] = registry.list(0).sort((a, b) => a.value.localeCompare(b.value));
    const sync = interpretSyncStatus(JSON.stringify({
      format: SYNC_STATUS_FORMAT, version: 1, synced_at: new Date(1_000_000).toISOString(),
      applied: [first!.id], rejected: [{ id: second!.id, reason: 'overlaps a protected range' }], error: null,
    }), 1_000_000, 180_000);
    const withSync = setup({ sync });
    withSync.registry.restore(registry.snapshot());
    const views = withSync.service.overview().blocks;
    expect(views.find((view) => view.id === first!.id)).toMatchObject({ enforcement: 'applied' });
    expect(views.find((view) => view.id === second!.id)).toMatchObject({ enforcement: 'rejected', enforcementReason: 'overlaps a protected range' });
  });
});

describe('interpretSyncStatus', () => {
  const base = { format: SYNC_STATUS_FORMAT, version: 1, synced_at: '2026-10-31T00:00:00.000Z', applied: [], rejected: [], error: null };
  const at = Date.parse('2026-10-31T00:00:00.000Z');

  it('無い・古い・エラー・壊れたを見分ける', () => {
    expect(interpretSyncStatus(null, at, 180_000).state).toBe('missing');
    expect(interpretSyncStatus(JSON.stringify(base), at + 60_000, 180_000).state).toBe('ok');
    expect(interpretSyncStatus(JSON.stringify(base), at + 181_000, 180_000).state).toBe('stale');
    expect(interpretSyncStatus(JSON.stringify({ ...base, error: 'blocks file is not valid JSON' }), at, 180_000))
      .toMatchObject({ state: 'error', reason: 'blocks file is not valid JSON' });
    expect(interpretSyncStatus('not json', at, 180_000).state).toBe('error');
  });

  it('先頭の BOM とオフセット付きの時刻を読む', () => {
    const text = `\uFEFF${JSON.stringify({ ...base, synced_at: '2026-10-31T09:00:00.000+09:00' })}`;
    expect(interpretSyncStatus(text, at, 180_000)).toMatchObject({ state: 'ok', syncedAtMs: at });
  });
});
