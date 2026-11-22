import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertTokenHeaderName,
  changeTokenHeader,
  planTokenHeader,
  readTokenHeaderState,
  selectTokenHeaderApp,
  type AccessAppConfig,
  type TokenHeaderAccessApi,
} from './access-token-header-service.js';
import { buildCfAccessTokenHeaderRouter } from './access-token-header-router.js';
import { CloudflareAccessApi, type CfAccessApp } from './cloudflare-access-api.js';
import { RouteRejectedError } from './route-service.js';

const AUD = 'f'.repeat(64);
const HOST = 'cc-playtest.ai-run-do.com';
const ALLOW = [HOST];

const app = (overrides: Partial<CfAccessApp> = {}): CfAccessApp => ({
  id: 'app-1', name: 'cc-playtest', domain: HOST, aud: AUD, type: 'self_hosted', ...overrides,
});

function currentConfig(overrides: AccessAppConfig = {}): AccessAppConfig {
  return {
    id: 'app-1',
    uid: 'app-1',
    aud: AUD,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    name: 'cc-playtest',
    domain: HOST,
    type: 'self_hosted',
    session_duration: '24h',
    app_launcher_visible: true,
    allowed_idps: ['idp-google'],
    self_hosted_domains: [HOST],
    policies: [
      { id: 'pol-1', name: 'BUSINESS', decision: 'allow', precedence: 1, include: [{ email: { email: 'a@example.com' } }], reusable: true },
      { id: 'pol-2', name: 'SERVICE', decision: 'non_identity', precedence: 2, include: [{ any_valid_service_token: {} }] },
    ],
    ...overrides,
  };
}

/** CF API のスタブ。getApp は現在の保存値を返し、updateApp は全体置換で保存する。 */
function stubApi(apps: CfAccessApp[], config: AccessAppConfig = currentConfig()) {
  let stored = { ...config };
  const updates: AccessAppConfig[] = [];
  const api: TokenHeaderAccessApi = {
    listApps: vi.fn(async () => apps),
    getApp: vi.fn(async () => stored),
    updateApp: vi.fn(async (_id: string, body: AccessAppConfig) => {
      updates.push(body);
      stored = { id: 'app-1', aud: AUD, ...body };
      return stored;
    }),
  };
  return { api, updates };
}

describe('assertTokenHeaderName', () => {
  it('RFC 7230 token の 1〜64 文字と null を通す', () => {
    expect(assertTokenHeaderName('cf-access-token')).toBe('cf-access-token');
    expect(assertTokenHeaderName('X_Token.1!#$%&\'*+^`|~')).toBe('X_Token.1!#$%&\'*+^`|~');
    expect(assertTokenHeaderName('a'.repeat(64))).toBe('a'.repeat(64));
    expect(assertTokenHeaderName(null)).toBeNull();
  });
  it('空・65 文字以上・区切り文字・空白・非文字列は 400 (入力拒否)', () => {
    for (const bad of ['', 'a'.repeat(65), 'bad header', 'x:y', 'a(b)', 'tab\t', 'é', undefined, 1, {}]) {
      expect(() => assertTokenHeaderName(bad)).toThrow(RouteRejectedError);
    }
  });
});

describe('selectTokenHeaderApp', () => {
  it('domain が完全一致 (大小無視) する self-hosted アプリ 1 件を返す', () => {
    const target = app({ domain: 'CC-Playtest.ai-run-do.com' });
    expect(selectTokenHeaderApp([app({ id: 'x', domain: 'other.example.com' }), target], HOST)).toBe(target);
  });
  it('0 件・複数・パス付きドメインのみ・self-hosted 以外は拒否', () => {
    expect(() => selectTokenHeaderApp([], HOST)).toThrow(/一致する self-hosted/);
    expect(() => selectTokenHeaderApp([app(), app({ id: 'app-2' })], HOST)).toThrow(/2 件/);
    expect(() => selectTokenHeaderApp([app({ domain: `${HOST}/api` })], HOST)).toThrow(/パス付き/);
    expect(() => selectTokenHeaderApp([app({ type: 'ssh' })], HOST)).toThrow(RouteRejectedError);
  });
});

describe('planTokenHeader', () => {
  it('全体置換の本体は他のフィールドを保ち、ヘッダ名だけを変える', () => {
    const plan = planTokenHeader(currentConfig(), 'cf-access-token');
    expect(plan).toMatchObject({ before: null, after: 'cf-access-token', changed: true });
    expect(plan.body).toEqual({
      name: 'cc-playtest',
      domain: HOST,
      type: 'self_hosted',
      session_duration: '24h',
      app_launcher_visible: true,
      allowed_idps: ['idp-google'],
      self_hosted_domains: [HOST],
      policies: [{ id: 'pol-1', precedence: 1 }, { id: 'pol-2', precedence: 2 }],
      read_service_tokens_from_header: 'cf-access-token',
    });
  });
  it('null は項目を外し、同じ値なら changed は false', () => {
    const current = currentConfig({ read_service_tokens_from_header: 'cf-access-token' });
    const removal = planTokenHeader(current, null);
    expect(removal.before).toBe('cf-access-token');
    expect('read_service_tokens_from_header' in removal.body).toBe(false);
    expect(planTokenHeader(current, 'cf-access-token').changed).toBe(false);
  });
});

describe('readTokenHeaderState', () => {
  it('アプリの識別情報と現行値だけを返し、AUD は出さない', async () => {
    const { api } = stubApi([app()], currentConfig({ read_service_tokens_from_header: 'cf-access-token' }));
    const state = await readTokenHeaderState(api, ALLOW, ` ${HOST.toUpperCase()} `);
    expect(state).toEqual({ app: { id: 'app-1', name: 'cc-playtest', domain: HOST }, read_service_tokens_from_header: 'cf-access-token' });
    expect(JSON.stringify(state)).not.toContain(AUD);
  });
  it('allowlist 外は CF を呼ぶ前に拒否', async () => {
    const { api } = stubApi([app()]);
    await expect(readTokenHeaderState(api, ALLOW, 'other.ai-run-do.com')).rejects.toThrow(/allowlist/);
    expect(api.listApps).not.toHaveBeenCalled();
  });
});

describe('changeTokenHeader', () => {
  it('apply が無ければ計画だけで書かない', async () => {
    const { api } = stubApi([app()]);
    const result = await changeTokenHeader(api, ALLOW, { hostname: HOST, header: 'cf-access-token' });
    expect(result).toEqual({
      plan: true, applied: false, changed: true,
      app: { id: 'app-1', name: 'cc-playtest', domain: HOST }, before: null, after: 'cf-access-token',
    });
    expect(api.updateApp).not.toHaveBeenCalled();
  });

  it('apply: true で全体置換を送り、他のフィールドは保たれ、before を返す', async () => {
    const { api, updates } = stubApi([app()], currentConfig({ read_service_tokens_from_header: 'old-header' }));
    const result = await changeTokenHeader(api, ALLOW, { hostname: HOST, header: 'cf-access-token', apply: true });
    expect(result).toMatchObject({ plan: false, applied: true, before: 'old-header', after: 'cf-access-token' });
    expect(updates).toHaveLength(1);
    const sent = updates[0] as AccessAppConfig;
    expect(sent).toMatchObject({
      domain: HOST, session_duration: '24h', allowed_idps: ['idp-google'], self_hosted_domains: [HOST],
      policies: [{ id: 'pol-1', precedence: 1 }, { id: 'pol-2', precedence: 2 }],
      read_service_tokens_from_header: 'cf-access-token',
    });
    expect(sent).not.toHaveProperty('aud');
    expect(JSON.stringify(result)).not.toContain(AUD);
  });

  it('値が変わらなければ apply: true でも書かない', async () => {
    const { api } = stubApi([app()], currentConfig({ read_service_tokens_from_header: 'cf-access-token' }));
    const result = await changeTokenHeader(api, ALLOW, { hostname: HOST, header: 'cf-access-token', apply: true });
    expect(result).toMatchObject({ plan: false, applied: false, changed: false });
    expect(api.updateApp).not.toHaveBeenCalled();
  });

  it('書いた後の読み直しが一致しなければ失敗にする (502 側)', async () => {
    const { api } = stubApi([app()]);
    vi.mocked(api.getApp).mockImplementation(async () => currentConfig());
    const err = await changeTokenHeader(api, ALLOW, { hostname: HOST, header: 'cf-access-token', apply: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RouteRejectedError);
  });

  it('allowlist 外・アプリ 0 件・複数・不正ヘッダ名は入力拒否 (400) で書かない', async () => {
    const cases: Array<[CfAccessApp[], Record<string, unknown>]> = [
      [[app()], { hostname: 'evil.example.com', header: 'cf-access-token', apply: true }],
      [[], { hostname: HOST, header: 'cf-access-token', apply: true }],
      [[app(), app({ id: 'app-2' })], { hostname: HOST, header: 'cf-access-token', apply: true }],
      [[app()], { hostname: HOST, header: 'bad header', apply: true }],
    ];
    for (const [apps, input] of cases) {
      const { api } = stubApi(apps);
      await expect(changeTokenHeader(api, ALLOW, input as never)).rejects.toThrow(RouteRejectedError);
      expect(api.updateApp).not.toHaveBeenCalled();
    }
  });
});

describe('CloudflareAccessApi getApp / updateApp', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('アプリ 1 件の GET と全体置換の PUT を同じパスへ送る', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, method: String(init.method), body: init.body === undefined ? undefined : JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ success: true, result: { id: 'app-1' } }), { status: 200 });
    }));
    const api = new CloudflareAccessApi({ token: 't', accountId: 'acc' } as never);
    await api.getApp('app-1');
    await api.updateApp('app-1', { domain: HOST });
    expect(calls).toEqual([
      { url: 'https://api.cloudflare.com/client/v4/accounts/acc/access/apps/app-1', method: 'GET', body: undefined },
      { url: 'https://api.cloudflare.com/client/v4/accounts/acc/access/apps/app-1', method: 'PUT', body: { domain: HOST } },
    ]);
  });
});

describe('token-header router input validation', () => {
  const router = buildCfAccessTokenHeaderRouter();
  it('GET は hostname が必須', async () => {
    expect((await router.request('/api/v1/cf-access/apps/token-header')).status).toBe(400);
  });
  it('PUT は hostname と header が必須 (CF に問い合わせる前に 400)', async () => {
    const put = (body: unknown) => router.request('/api/v1/cf-access/apps/token-header', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    expect((await put({ hostname: HOST })).status).toBe(400);
    expect((await put({ header: 'x' })).status).toBe(400);
  });
});
