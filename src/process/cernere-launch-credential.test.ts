import { describe, expect, it, vi } from 'vitest';
import type { Service } from '../catalog/loader.js';
import { prepareSpawnEnv } from './cernere-launch-credential.js';

function service(patch: Partial<Service> = {}): Service {
  return {
    code: 'glab',
    name: 'GLAB',
    runtime: 'node',
    disabled: false,
    monitor_only: false,
    autostart: false,
    restart_policy: 'no',
    max_restart: 5,
    required_env: [],
    cernere_launch_credentials: {
      target_project: 'glab',
      issuer_client_id_env: 'EXCUBITOR_CERNERE_CLIENT_ID',
      issuer_client_secret_env: 'EXCUBITOR_CERNERE_CLIENT_SECRET',
    },
    ...patch,
  } as Service;
}

describe('prepareSpawnEnv', () => {
  it('issues a credential per launch and strips the issuer secret from the child env', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        client_id: 'ex-id',
        client_secret: 'ex-secret',
        target_project_key: 'glab',
        launch_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        target_client_secret: 'ex-generated-glab-secret-0123456789abcdef',
      });
      return new Response(JSON.stringify({
        targetProjectKey: 'glab',
        launchId: body.launch_id,
        clientId: 'glab-client-id',
        adminUserIds: ['11111111-1111-4111-8111-111111111111'],
        issuedAt: '2026-07-11T00:00:00.000Z',
        idempotent: false,
      }), { status: 201, headers: { 'content-type': 'application/json' } });
    });

    const env = await prepareSpawnEnv(service(), {
      CERNERE_BASE_URL: 'http://localhost:8080',
      EXCUBITOR_CERNERE_CLIENT_ID: 'ex-id',
      EXCUBITOR_CERNERE_CLIENT_SECRET: 'ex-secret',
      CORPUS_PUBLIC_URL: 'http://localhost:5187',
    }, {
      fetchImpl: fetchImpl as typeof fetch,
      launchId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      targetClientSecret: 'ex-generated-glab-secret-0123456789abcdef',
    });

    expect(env).toMatchObject({
      CERNERE_PROJECT_CLIENT_ID: 'glab-client-id',
      CERNERE_PROJECT_CLIENT_SECRET: 'ex-generated-glab-secret-0123456789abcdef',
      CORPUS_ADMIN_IDS: '11111111-1111-4111-8111-111111111111',
    });
    expect(env).not.toHaveProperty('EXCUBITOR_CERNERE_CLIENT_ID');
    expect(env).not.toHaveProperty('EXCUBITOR_CERNERE_CLIENT_SECRET');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('strips issuer credentials even when they came from the inherited process env map', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      targetProjectKey: 'glab',
      launchId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      clientId: 'glab-id',
      adminUserIds: ['22222222-2222-4222-8222-222222222222'],
      issuedAt: '2026-07-11T00:00:00.000Z',
      idempotent: false,
    }), { status: 201, headers: { 'content-type': 'application/json' } }));

    const env = await prepareSpawnEnv(service(), {
      PATH: 'inherited',
      CERNERE_BASE_URL: 'http://localhost:8080',
      EXCUBITOR_CERNERE_CLIENT_ID: 'inherited-ex-id',
      EXCUBITOR_CERNERE_CLIENT_SECRET: 'inherited-ex-secret',
    }, {
      fetchImpl: fetchImpl as typeof fetch,
      launchId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      targetClientSecret: 'another-ex-generated-secret-0123456789abcdef',
    });

    expect(env.PATH).toBe('inherited');
    expect(env).not.toHaveProperty('EXCUBITOR_CERNERE_CLIENT_ID');
    expect(env).not.toHaveProperty('EXCUBITOR_CERNERE_CLIENT_SECRET');
  });

  it('does not issue credentials for services without launch configuration', async () => {
    const fetchImpl = vi.fn();
    const env = await prepareSpawnEnv(service({ cernere_launch_credentials: undefined }), {
      STATIC: 'value',
    }, { fetchImpl: fetchImpl as typeof fetch });
    expect(env).toEqual({ STATIC: 'value' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails closed without exposing an error response body', async () => {
    const fetchImpl = vi.fn(async () => new Response('sensitive body', { status: 403 }));
    await expect(prepareSpawnEnv(service(), {
      CERNERE_BASE_URL: 'http://localhost:8080',
      EXCUBITOR_CERNERE_CLIENT_ID: 'ex-id',
      EXCUBITOR_CERNERE_CLIENT_SECRET: 'ex-secret',
    }, { fetchImpl: fetchImpl as typeof fetch }))
      .rejects.toThrow('HTTP 403');
  });

  it('retries a network failure with the same launch id and secret', async () => {
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body));
      if (bodies.length === 1) throw new TypeError('connection reset');
      const body = JSON.parse(bodies[1]!) as Record<string, unknown>;
      return new Response(JSON.stringify({
        targetProjectKey: 'glab',
        launchId: body.launch_id,
        clientId: 'glab-id',
        adminUserIds: ['33333333-3333-4333-8333-333333333333'],
        issuedAt: '2026-07-11T00:00:00.000Z',
        idempotent: true,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    await prepareSpawnEnv(service(), {
      CERNERE_BASE_URL: 'http://127.0.0.1:8080',
      EXCUBITOR_CERNERE_CLIENT_ID: 'ex-id',
      EXCUBITOR_CERNERE_CLIENT_SECRET: 'ex-secret',
    }, {
      fetchImpl: fetchImpl as typeof fetch,
      launchId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      targetClientSecret: 'stable-secret-across-retries-0123456789abcdef',
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(bodies[1]).toBe(bodies[0]);
  });

  it('rejects a response bound to another launch', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      targetProjectKey: 'glab',
      launchId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      clientId: 'glab-id',
      adminUserIds: ['44444444-4444-4444-8444-444444444444'],
      issuedAt: '2026-07-11T00:00:00.000Z',
      idempotent: false,
    }), { status: 201, headers: { 'content-type': 'application/json' } }));

    await expect(prepareSpawnEnv(service(), {
      CERNERE_BASE_URL: 'https://cernere.example',
      EXCUBITOR_CERNERE_CLIENT_ID: 'ex-id',
      EXCUBITOR_CERNERE_CLIENT_SECRET: 'ex-secret',
    }, {
      fetchImpl: fetchImpl as typeof fetch,
      launchId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      targetClientSecret: 'generated-secret-0123456789abcdef',
    })).rejects.toThrow('response is invalid');
  });

  it('rejects plaintext transport to a non-loopback Cernere host', async () => {
    await expect(prepareSpawnEnv(service(), {
      CERNERE_BASE_URL: 'http://cernere.example',
      EXCUBITOR_CERNERE_CLIENT_ID: 'ex-id',
      EXCUBITOR_CERNERE_CLIENT_SECRET: 'ex-secret',
    })).rejects.toThrow('must use HTTPS');
  });
});
