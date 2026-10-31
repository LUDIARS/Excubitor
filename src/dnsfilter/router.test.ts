/** @implements SPEC-EX-DNS-FILTER */
import { describe, expect, it } from 'vitest';
import { DomainSet } from './domain-rules.js';
import { QueryLog } from './query-log.js';
import { buildDnsFilterRouter } from './router.js';
import { RuleRegistry } from './rule-registry.js';
import { RuleService } from './rule-service.js';
import type { DnsFilterStatus } from './runtime.js';

function app() {
  const log = new QueryLog(10);
  const rules = new RuleService({
    registry: new RuleRegistry(),
    limits: () => ({ limits: { maxRules: 10, maxTtlMs: 86_400_000, allowed: new DomainSet() }, reason: null }),
    persist: async () => undefined,
    now: () => 0,
  });
  const status: DnsFilterStatus = {
    state: 'running', reason: null, configError: null, listen: ['127.0.0.1:53'], upstream: '1.1.1.1:53',
    counters: { ...log.counters }, inFlight: 0, rules: { api: 0, config: 0, doh: 12, allowed: 0 },
  };
  const router = buildDnsFilterRouter({ status: () => status, queries: (limit, filter) => log.recent(limit, filter), rules });
  return { router, log };
}

function post(body: unknown) {
  return { method: 'POST', headers: { 'content-type': 'application/json', 'x-excubitor-actor': 'operator' }, body: JSON.stringify(body) };
}

describe('buildDnsFilterRouter', () => {
  it('status は待ち受けと規則の数を返す', async () => {
    const body = await (await app().router.request('/api/v1/dns-filter/status')).json() as Record<string, unknown>;
    expect(body).toMatchObject({ state: 'running', listen: ['127.0.0.1:53'], upstream: '1.1.1.1:53', rules: { doh: 12 } });
  });

  it('規則を POST で登録 (201)、 GET で一覧、 DELETE で解除', async () => {
    const { router } = app();
    const created = await router.request('/api/v1/dns-filter/rules', post({ domain: 'Tracker.Example', reason: '追跡', ttl_minutes: 30 }));
    expect(created.status).toBe(201);
    const { rule } = await created.json() as { rule: { id: string; domain: string; created_by: string; expires_at: string } };
    expect(rule).toMatchObject({ domain: 'tracker.example', created_by: 'operator', expires_at: '1970-01-01T00:30:00.000Z' });
    const listed = await (await router.request('/api/v1/dns-filter/rules')).json() as { state: string; rules: unknown[] };
    expect(listed).toMatchObject({ state: 'ok', rules: [{ domain: 'tracker.example' }] });
    expect((await router.request(`/api/v1/dns-filter/rules/${rule.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await router.request(`/api/v1/dns-filter/rules/${rule.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('不正な本文・余計な項目・不正な id は 400', async () => {
    const { router } = app();
    expect((await router.request('/api/v1/dns-filter/rules', post({ domain: 'a.example' }))).status).toBe(400);
    expect((await router.request('/api/v1/dns-filter/rules', post({ domain: 'a.example', reason: 'x', kind: 'x' }))).status).toBe(400);
    expect((await router.request('/api/v1/dns-filter/rules', { method: 'POST', body: '{' })).status).toBe(400);
    expect((await router.request('/api/v1/dns-filter/rules/not-a-uuid', { method: 'DELETE' })).status).toBe(400);
  });

  it('queries は action と名前で絞り、 limit を確かめる', async () => {
    const { router, log } = app();
    const base = { atMs: 0, client: '127.0.0.1', transport: 'udp' as const, type: 'A', rule: null, source: null, rcode: 0, detail: null, elapsedMs: 1 };
    log.add({ ...base, name: 'a.example', action: 'allowed' });
    log.add({ ...base, name: 'ads.example', action: 'blocked', rule: 'ads.example', source: 'config', rcode: 3 });
    const blocked = await (await router.request('/api/v1/dns-filter/queries?action=blocked')).json() as { queries: Array<{ name: string; rule: string }> };
    expect(blocked.queries).toEqual([expect.objectContaining({ name: 'ads.example', rule: 'ads.example', elapsed_ms: 1 })]);
    const named = await (await router.request('/api/v1/dns-filter/queries?name=A.EX')).json() as { queries: unknown[] };
    expect(named.queries).toHaveLength(1);
    expect((await router.request('/api/v1/dns-filter/queries?limit=0')).status).toBe(400);
    expect((await router.request('/api/v1/dns-filter/queries?action=refused')).status).toBe(400);
  });
});
