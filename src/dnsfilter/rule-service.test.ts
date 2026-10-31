/** @implements SPEC-EX-DNS-FILTER */
import { describe, expect, it } from 'vitest';
import { DomainSet } from './domain-rules.js';
import { RuleRegistry, RULES_FILE_FORMAT } from './rule-registry.js';
import { RuleService, type RuleLimits } from './rule-service.js';

function setup(options: { limits?: Partial<RuleLimits> | null; persist?: (content: string) => Promise<void>; now?: () => number } = {}) {
  const registry = new RuleRegistry();
  const writes: string[] = [];
  let clock = 0;
  const service = new RuleService({
    registry,
    limits: () => options.limits === null
      ? { limits: null, reason: 'dns_filter.enabled=false' }
      : { limits: { maxRules: 3, maxTtlMs: 600_000, allowed: new DomainSet(['ok.example']), ...options.limits }, reason: null },
    persist: options.persist ?? (async (content) => { writes.push(content); }),
    now: options.now ?? (() => clock),
  });
  return { registry, service, writes, advance: (ms: number) => { clock += ms; } };
}

describe('RuleService', () => {
  it('正規化して登録し、 ファイルを書く。 期限を省くと期限なし', async () => {
    const { service, writes } = setup();
    const added = await service.add({ domain: '*.Tracker.Example.', reason: '追跡', actor: 'operator' });
    expect(added).toMatchObject({ ok: true, value: { domain: 'tracker.example', expiresAtMs: null, createdBy: 'operator' } });
    const file = JSON.parse(writes[0]!) as { format: string; rules: Array<{ domain: string; expires_at: string | null }> };
    expect(file.format).toBe(RULES_FILE_FORMAT);
    expect(file.rules).toEqual([expect.objectContaining({ domain: 'tracker.example', expires_at: null })]);
  });

  it('不正なドメイン・期限、 許可の一覧に当たるもの、 重複、 上限超えを断る', async () => {
    const { service } = setup();
    expect(await service.add({ domain: 'not a domain', reason: 'x', actor: 'a' })).toMatchObject({ ok: false, status: 400 });
    expect(await service.add({ domain: 'a.example', reason: 'x', ttlMinutes: 11, actor: 'a' })).toMatchObject({ ok: false, status: 400 });
    expect(await service.add({ domain: 'x.ok.example', reason: 'x', actor: 'a' })).toMatchObject({ ok: false, status: 409 });
    await service.add({ domain: 'a.example', reason: 'x', actor: 'a' });
    expect(await service.add({ domain: 'A.example', reason: 'x', actor: 'a' })).toMatchObject({ ok: false, status: 409, existing: { domain: 'a.example' } });
    await service.add({ domain: 'b.example', reason: 'x', actor: 'a' });
    await service.add({ domain: 'c.example', reason: 'x', actor: 'a' });
    expect(await service.add({ domain: 'd.example', reason: 'x', actor: 'a' })).toMatchObject({ ok: false, status: 409, error: '規則は 3 件まで' });
  });

  it('期限が来たものは一覧から消え、 expire でファイルからも外す', async () => {
    const { service, writes, advance } = setup();
    await service.add({ domain: 'short.example', reason: 'x', ttlMinutes: 1, actor: 'a' });
    await service.add({ domain: 'forever.example', reason: 'x', actor: 'a' });
    advance(60_001);
    expect(service.overview().rules.map((rule) => rule.domain)).toEqual(['forever.example']);
    await service.expire();
    expect(writes).toHaveLength(3);
    expect(writes[2]).not.toContain('short.example');
  });

  it('書けなければ巻き戻して 503', async () => {
    const { service, registry } = setup({ persist: async () => { throw new Error('disk full'); } });
    expect(await service.add({ domain: 'a.example', reason: 'x', actor: 'a' })).toMatchObject({ ok: false, status: 503 });
    expect(registry.list(0)).toEqual([]);
  });

  it('解除。 無い id は 404', async () => {
    const { service } = setup();
    const added = await service.add({ domain: 'a.example', reason: 'x', actor: 'a' });
    if (!added.ok) throw new Error(added.error);
    expect(await service.remove(added.value.id)).toMatchObject({ ok: true, value: { domain: 'a.example' } });
    expect(await service.remove(added.value.id)).toMatchObject({ ok: false, status: 404 });
  });

  it('無効なら 503、 規則ファイルが壊れていれば変更を受けない', async () => {
    expect(await setup({ limits: null }).service.add({ domain: 'a.example', reason: 'x', actor: 'a' })).toMatchObject({ ok: false, status: 503 });
    const { service, registry } = setup();
    registry.load('{"format":"other"}');
    expect(service.overview().state).toBe('failed');
    expect(await service.add({ domain: 'a.example', reason: 'x', actor: 'a' })).toMatchObject({ ok: false, status: 503 });
  });

  it('書いたファイルを読み直すと同じ規則になる', async () => {
    const { service, writes } = setup();
    await service.add({ domain: 'a.example', reason: '理由', ttlMinutes: 5, actor: 'a' });
    const reloaded = new RuleRegistry();
    reloaded.load(writes[0]!);
    expect(reloaded.status().state).toBe('ok');
    expect(reloaded.list(0)).toEqual(service.overview().rules);
  });
});
