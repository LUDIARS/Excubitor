import { describe, expect, it, vi } from 'vitest';
import type { Service } from '../../catalog/loader.js';
import type { StepResult } from '../../update/steps.js';
import type { OperationContext } from './context.js';
import { holdSiteToken, publicSiteMeta, runConcordiaSiteOperation, takeSiteToken } from './concordia-site.js';
import type { OperationRecord } from './store.js';
import { OperationRequestSchema } from './types.js';

const SITE = { hq_url: 'ws://100.122.174.105:11112', site_id: 'melpot', token: 'secret-token-value' };
const concordia = { code: 'concordia', name: 'Concordia', port: 11111 } as Service;

function makeCtx(meta: Record<string, unknown> = { federation_site: publicSiteMeta(SITE) }): { ctx: OperationContext; steps: StepResult[] } {
  const steps: StepResult[] = [];
  const op = { id: 'op-1', meta, target: { kind: 'service', code: 'concordia' }, action: 'concordia-federation-site' } as unknown as OperationRecord;
  return { ctx: { op, actor: 'federation:HQ', requester: null, record: (s) => steps.push(s) }, steps };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('concordia-federation-site request schema', () => {
  it('accepts the action only with federation_site and only for service concordia', () => {
    const ok = OperationRequestSchema.safeParse({ target: { kind: 'service', code: 'concordia' }, action: 'concordia-federation-site', federation_site: SITE });
    expect(ok.success).toBe(true);
    expect(OperationRequestSchema.safeParse({ target: { kind: 'service', code: 'concordia' }, action: 'concordia-federation-site' }).success).toBe(false);
    expect(OperationRequestSchema.safeParse({ target: { kind: 'service', code: 'actio' }, action: 'concordia-federation-site', federation_site: SITE }).success).toBe(false);
    expect(OperationRequestSchema.safeParse({ target: { kind: 'service', code: 'concordia' }, action: 'restart', federation_site: SITE }).success).toBe(false);
  });

  it('rejects malformed site options', () => {
    const bad = (site: Record<string, unknown>) => OperationRequestSchema.safeParse({
      target: { kind: 'service', code: 'concordia' }, action: 'concordia-federation-site', federation_site: site,
    }).success;
    expect(bad({ ...SITE, hq_url: 'http://100.1.1.1:11112' })).toBe(false);
    expect(bad({ ...SITE, site_id: 'Bad_ID' })).toBe(false);
    expect(bad({ ...SITE, token: '' })).toBe(false);
    expect(bad({ ...SITE, extra: 1 })).toBe(false);
  });

  it('keeps the token out of the recorded meta', () => {
    expect(publicSiteMeta(SITE)).toEqual({ hq_url: SITE.hq_url, site_id: 'melpot' });
  });
});

describe('site token holder', () => {
  it('hands the token out once', () => {
    holdSiteToken('op-x', 't');
    expect(takeSiteToken('op-x')).toBe('t');
    expect(takeSiteToken('op-x')).toBeNull();
  });
});

describe('runConcordiaSiteOperation', () => {
  it('PUTs the site role to loopback Concordia and succeeds when the saved state matches', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { hqUrl: SITE.hq_url, siteId: 'melpot', hasToken: true, running: { linked: false } }));
    const { ctx, steps } = makeCtx();
    const outcome = await runConcordiaSiteOperation(ctx, concordia, { fetch: fetchMock as unknown as typeof fetch, takeToken: () => SITE.token });
    expect(outcome).toEqual({ kind: 'finished', ok: true, error: null });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:11111/v1/federation/site');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ hq_url: SITE.hq_url, site_id: 'melpot', token: SITE.token });
    expect(JSON.stringify(steps)).not.toContain(SITE.token);
  });

  it('fails without calling Concordia when the token is gone (restart while queued)', async () => {
    const fetchMock = vi.fn();
    const { ctx } = makeCtx();
    const outcome = await runConcordiaSiteOperation(ctx, concordia, { fetch: fetchMock as unknown as typeof fetch, takeToken: () => null });
    expect(outcome).toMatchObject({ ok: false, error: 'token_unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports Concordia rejection without echoing the token', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(400, { error: `bad hq_url ${SITE.token}`.slice(0, 11) }));
    const { ctx, steps } = makeCtx();
    const outcome = await runConcordiaSiteOperation(ctx, concordia, { fetch: fetchMock as unknown as typeof fetch, takeToken: () => SITE.token });
    expect(outcome).toMatchObject({ ok: false, error: 'concordia_rejected_400' });
    expect(JSON.stringify(steps)).not.toContain(SITE.token);
  });

  it('fails when the saved state does not match the request', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { hqUrl: SITE.hq_url, siteId: 'other', hasToken: true }));
    const { ctx } = makeCtx();
    const outcome = await runConcordiaSiteOperation(ctx, concordia, { fetch: fetchMock as unknown as typeof fetch, takeToken: () => SITE.token });
    expect(outcome).toMatchObject({ ok: false, error: 'concordia_site_mismatch' });
  });

  it('fails when Concordia has no catalog port or is unreachable', async () => {
    const { ctx } = makeCtx();
    expect(await runConcordiaSiteOperation(ctx, undefined, { takeToken: () => SITE.token })).toMatchObject({ error: 'concordia_port_unknown' });
    const down = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const again = makeCtx();
    expect(await runConcordiaSiteOperation(again.ctx, concordia, { fetch: down as unknown as typeof fetch, takeToken: () => SITE.token }))
      .toMatchObject({ error: 'concordia_unreachable' });
  });
});
