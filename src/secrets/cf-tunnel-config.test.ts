import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildConfigRouter } from './router.js';
import { getCfTunnelStatus } from './config-store.js';

const ORIGINAL_ENV = { ...process.env };

const CF_ENV_KEYS = [
  'EXCUBITOR_CF_INFISICAL_PROJECT_ID',
  'EXCUBITOR_CF_INFISICAL_ENV',
  'EXCUBITOR_CF_TUNNEL_ALLOWED_HOSTNAMES',
  'EXCUBITOR_CF_API_TOKEN',
  'EXCUBITOR_CF_ACCOUNT_ID',
] as const;

describe('CF Tunnel config API', () => {
  let tempDir = '';

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'excubitor-cf-tunnel-'));
    process.env = {
      ...ORIGINAL_ENV,
      EXCUBITOR_CONFIG_PATH: join(tempDir, 'config.enc'),
      EXCUBITOR_MASTER_KEY: 'cf-tunnel-test-master-key',
    };
    for (const key of CF_ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    rmSync(tempDir, { recursive: true, force: true });
  });

  const put = (app: ReturnType<typeof buildConfigRouter>, body: unknown) =>
    app.request('/api/v1/config/cf-tunnel', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('保存した設定が config source として読み返せる (hostname は正規化 + 重複除去)', async () => {
    const app = buildConfigRouter();
    const saved = await put(app, {
      infisical_project_id: ' proj-1 ',
      infisical_environment: 'dev',
      allowed_hostnames: [' A.example.com ', 'a.example.com', 'b.example.com'],
    });
    expect(saved.status).toBe(200);

    const res = await app.request('/api/v1/config/cf-tunnel');
    const body = (await res.json()) as { cf_tunnel: Record<string, unknown> };
    expect(body.cf_tunnel).toMatchObject({
      infisical_project_id: 'proj-1',
      infisical_project_source: 'config',
      infisical_environment: 'dev',
      infisical_environment_source: 'config',
      allowed_hostnames: ['a.example.com', 'b.example.com'],
      allowed_hostnames_source: 'config',
      direct_env_credentials: false,
    });
  });

  it('不正な hostname (パス・スキーム入り) は 400 で拒否する', async () => {
    const app = buildConfigRouter();
    const res = await put(app, { allowed_hostnames: ['https://a.example.com/path'] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_cf_tunnel_settings');
  });

  it('部分更新: 渡さなかったフィールドは保持し、空文字/空配列は設定解除になる', async () => {
    const app = buildConfigRouter();
    await put(app, { infisical_project_id: 'proj-1', allowed_hostnames: ['a.example.com'] });
    await put(app, { infisical_environment: 'prod' });

    let res = await app.request('/api/v1/config/cf-tunnel');
    let body = (await res.json()) as { cf_tunnel: Record<string, unknown> };
    expect(body.cf_tunnel).toMatchObject({
      infisical_project_id: 'proj-1',
      infisical_environment: 'prod',
      allowed_hostnames: ['a.example.com'],
    });

    await put(app, { infisical_project_id: '', allowed_hostnames: [] });
    res = await app.request('/api/v1/config/cf-tunnel');
    body = (await res.json()) as { cf_tunnel: Record<string, unknown> };
    expect(body.cf_tunnel).toMatchObject({
      infisical_project_id: null,
      infisical_project_source: 'unset',
      allowed_hostnames: [],
      allowed_hostnames_source: 'unset',
      infisical_environment: 'prod',
    });
  });

  it('env が設定されていれば config より優先され source=env になる', async () => {
    const app = buildConfigRouter();
    await put(app, {
      infisical_project_id: 'proj-config',
      allowed_hostnames: ['config.example.com'],
    });
    process.env.EXCUBITOR_CF_INFISICAL_PROJECT_ID = 'proj-env';
    process.env.EXCUBITOR_CF_TUNNEL_ALLOWED_HOSTNAMES = 'Env.example.com';

    const res = await app.request('/api/v1/config/cf-tunnel');
    const body = (await res.json()) as { cf_tunnel: Record<string, unknown> };
    expect(body.cf_tunnel).toMatchObject({
      infisical_project_id: 'proj-env',
      infisical_project_source: 'env',
      allowed_hostnames: ['env.example.com'],
      allowed_hostnames_source: 'env',
    });
  });

  // env が config を隠している間も、 編集 UI が下書きに使う「素の保存値」は別に見えないと
  // いけない。 解決値を下書きにすると env の値をそのまま保存して config を潰す。
  it('env が優先されていても stored は config store の素の値を返す', async () => {
    const app = buildConfigRouter();
    await put(app, {
      infisical_project_id: 'proj-config',
      infisical_environment: 'dev',
      allowed_hostnames: ['config.example.com'],
    });
    process.env.EXCUBITOR_CF_INFISICAL_PROJECT_ID = 'proj-env';
    process.env.EXCUBITOR_CF_INFISICAL_ENV = 'staging';
    process.env.EXCUBITOR_CF_TUNNEL_ALLOWED_HOSTNAMES = 'env.example.com';

    const res = await app.request('/api/v1/config/cf-tunnel');
    const body = (await res.json()) as { cf_tunnel: { stored: Record<string, unknown> } };
    expect(body.cf_tunnel.stored).toEqual({
      infisical_project_id: 'proj-config',
      infisical_environment: 'dev',
      allowed_hostnames: ['config.example.com'],
    });
  });

  it('未設定なら stored は空 (null / 空配列)', async () => {
    const app = buildConfigRouter();
    const res = await app.request('/api/v1/config/cf-tunnel');
    const body = (await res.json()) as { cf_tunnel: { stored: Record<string, unknown> } };
    expect(body.cf_tunnel.stored).toEqual({
      infisical_project_id: null,
      infisical_environment: null,
      allowed_hostnames: [],
    });
  });

  it('返却した hostname 配列の変更は config cache を壊さない', async () => {
    const app = buildConfigRouter();
    await put(app, { allowed_hostnames: ['config.example.com'] });

    const first = getCfTunnelStatus();
    first.allowed_hostnames.push('mutated.example.com');
    first.stored.allowed_hostnames.push('also-mutated.example.com');

    const second = getCfTunnelStatus();
    expect(second.allowed_hostnames).toEqual(['config.example.com']);
    expect(second.stored.allowed_hostnames).toEqual(['config.example.com']);
  });
});
