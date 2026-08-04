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
  it('combines service required_env and infisical required_env', () => {
    const svc = service({
      required_env: ['STATIC_KEY'],
      infisical: {
        project_id: 'project',
        environment: 'dev',
        inject: true,
        prefix: '',
        required_env: ['SECRET_KEY'],
      },
    });

    expect(requiredEnvKeysForService(svc)).toEqual(['STATIC_KEY', 'SECRET_KEY']);
  });

  it('does not require infisical include keys (include is a filter, not a requirement)', () => {
    // Volputas の GLAB_SERVICE_TOKEN は Discord リレー専用の任意 secret。 include に
    // 挙げただけで必須化されると、 リレーを使わない構成でサービスが起動できなくなる。
    const svc = service({
      required_env: ['STATIC_KEY'],
      infisical: {
        project_id: 'project',
        environment: 'dev',
        inject: true,
        prefix: '',
        include: ['FILTERED_KEY', 'OPTIONAL_TOKEN'],
      },
    });

    expect(requiredEnvKeysForService(svc)).toEqual(['STATIC_KEY']);
    expect(validateStartupEnv(svc, { STATIC_KEY: 'ok' }).ready).toBe(true);
  });

  it('still requires an include key when it is also declared required', () => {
    const svc = service({
      infisical: {
        project_id: 'project',
        environment: 'dev',
        inject: true,
        prefix: '',
        required_env: ['DB_URL'],
        include: ['DB_URL', 'OPTIONAL_TOKEN'],
      },
    });

    expect(requiredEnvKeysForService(svc)).toEqual(['DB_URL']);
    expect(validateStartupEnv(svc, { OPTIONAL_TOKEN: 'x' }).missing).toEqual(['DB_URL']);
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
        target_project: 'EducationLab',
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
