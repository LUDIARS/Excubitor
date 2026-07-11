import { describe, expect, it } from 'vitest';
import type { Service } from '../catalog/loader.js';
import { requiredEnvKeysForService, validateStartupEnv } from './startup-env.js';

function service(patch: Partial<Service>): Service {
  return {
    code: `startup-env-test-${Math.random().toString(36).slice(2)}`,
    name: 'startup env test',
    runtime: 'node',
    disabled: false,
    monitor_only: false,
    autostart: false,
    restart_policy: 'no',
    max_restart: 5,
    required_env: [],
    ...patch,
  } as Service;
}

describe('startup env validation', () => {
  it('combines service required_env, infisical required_env, and include', () => {
    const svc = service({
      required_env: ['STATIC_KEY'],
      infisical: {
        project_id: 'project',
        environment: 'dev',
        inject: true,
        prefix: '',
        required_env: ['SECRET_KEY'],
        include: ['FILTERED_KEY'],
      },
    });

    expect(requiredEnvKeysForService(svc)).toEqual(['STATIC_KEY', 'SECRET_KEY', 'FILTERED_KEY']);
  });

  it('includes flattened requires_secret keys (cross-service secrets)', () => {
    const svc = service({
      requires_secret: [
        { service: 'cernere', keys: ['AEDILIS_CERNERE_CLIENT_ID', 'AEDILIS_CERNERE_CLIENT_SECRET'] },
      ],
    });

    expect(requiredEnvKeysForService(svc)).toEqual([
      'AEDILIS_CERNERE_CLIENT_ID',
      'AEDILIS_CERNERE_CLIENT_SECRET',
    ]);
  });

  it('marks missing or blank values as not ready', () => {
    const svc = service({ required_env: ['PRESENT', 'BLANK', 'MISSING'] });

    expect(validateStartupEnv(svc, { PRESENT: 'ok', BLANK: '   ' })).toEqual({
      required: ['PRESENT', 'BLANK', 'MISSING'],
      missing: ['BLANK', 'MISSING'],
      ready: false,
    });
  });

  it('requires the stable Excubitor issuer credential for dynamic Cernere launches', () => {
    const svc = service({
      cernere_launch_credentials: {
        target_project: 'glab',
        issuer_client_id_env: 'EXCUBITOR_CERNERE_CLIENT_ID',
        issuer_client_secret_env: 'EXCUBITOR_CERNERE_CLIENT_SECRET',
      },
    });
    expect(requiredEnvKeysForService(svc)).toEqual([
      'EXCUBITOR_CERNERE_CLIENT_ID',
      'EXCUBITOR_CERNERE_CLIENT_SECRET',
    ]);
  });
});
