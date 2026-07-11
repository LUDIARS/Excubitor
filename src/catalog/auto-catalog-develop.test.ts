import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Catalog, Service } from './loader.js';
import { developServiceFor, runScan } from './auto-catalog.js';

const ENV_KEYS = ['EXCUBITOR_ARS_ROOT', 'EXCUBITOR_DEVELOP_ROOT', 'EXCUBITOR_AUTO_CATALOG_PATH'] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
let root: string;

function service(extra: Partial<Service> = {}): Service {
  return {
    code: 'concordia',
    name: 'Concordia',
    project_code: 'concordia',
    runtime: 'node',
    cwd: join(root, 'Concordia'),
    command: 'node dist/server.js',
    port: 11111,
    disabled: false,
    monitor_only: false,
    autostart: true,
    allow_hot_reload: false,
    restart_policy: 'no',
    max_restart: 5,
    depends_on: [],
    required_env: [],
    develop_derived: false,
    ...extra,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'excubitor-develop-catalog-'));
  process.env.EXCUBITOR_ARS_ROOT = root;
  process.env.EXCUBITOR_DEVELOP_ROOT = join(root, 'develop');
  process.env.EXCUBITOR_AUTO_CATALOG_PATH = join(root, 'services.auto.yaml');
  mkdirSync(join(root, 'Concordia'), { recursive: true });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe('developServiceFor', () => {
  it('起動設定を継承し clone 側 cwd と安全な autostart を設定する', () => {
    mkdirSync(join(root, 'develop', 'Concordia'), { recursive: true });

    expect(developServiceFor(service())).toMatchObject({
      code: 'concordia-develop',
      name: 'Concordia (develop)',
      project_code: 'concordia',
      runtime: 'node',
      cwd: join(root, 'develop', 'Concordia').replace(/\\/g, '/'),
      command: 'node dist/server.js',
      port: 11111,
      autostart: false,
      develop_derived: true,
      develop_from: 'concordia',
    });
  });

  it('repo 内の compose_file と subdirectory cwd を clone 側へ移す', () => {
    mkdirSync(join(root, 'develop', 'Concordia'), { recursive: true });
    const derived = developServiceFor(service({
      runtime: 'docker-compose',
      cwd: join(root, 'Concordia', 'web'),
      compose_file: join(root, 'Concordia', 'docker-compose.yaml'),
      command: undefined,
    }));

    expect(derived?.cwd).toBe(join(root, 'develop', 'Concordia', 'web').replace(/\\/g, '/'));
    expect(derived?.compose_file).toBe(join(root, 'develop', 'Concordia', 'docker-compose.yaml').replace(/\\/g, '/'));
  });

  it.each([
    ['disabled', { disabled: true }],
    ['monitor-only', { monitor_only: true }],
    ['Excubitor itself', { code: 'excubitor', project_code: 'excubitor' }],
    ['infra service', { code: 'infra-postgres' }],
  ])('%s は生成しない', (_label, extra) => {
    mkdirSync(join(root, 'develop', 'Concordia'), { recursive: true });
    expect(developServiceFor(service(extra))).toBeNull();
  });
});

describe('runScan develop clones', () => {
  it('存在する clone の develop エントリを services.auto.yaml に生成する', async () => {
    mkdirSync(join(root, 'develop', 'Concordia'), { recursive: true });
    const catalog = { services: [service()] } as unknown as Catalog;

    const first = await runScan(catalog);
    const second = await runScan(catalog);
    const parsed = load(readFileSync(process.env.EXCUBITOR_AUTO_CATALOG_PATH!, 'utf8')) as { services: Service[] };

    expect(first.created).toContain('concordia-develop');
    expect(second.created).not.toContain('concordia-develop');
    expect(parsed.services).toHaveLength(1);
    expect(parsed.services[0]).toMatchObject({
      code: 'concordia-develop',
      cwd: join(root, 'develop', 'Concordia').replace(/\\/g, '/'),
      port: 11111,
      autostart: false,
    });
  });

  it('develop clone が無ければ従来の auto entry を変更しない', async () => {
    const legacy = {
      code: 'legacy',
      name: 'Legacy',
      project_code: 'legacy',
      runtime: 'node',
      cwd: join(root, 'Legacy'),
      command: 'npm start',
      autostart: false,
      monitor_only: false,
    };
    writeFileSync(process.env.EXCUBITOR_AUTO_CATALOG_PATH!, `services:\n  - ${JSON.stringify(legacy)}\n`, 'utf8');

    await runScan({ services: [] } as unknown as Catalog);
    const parsed = load(readFileSync(process.env.EXCUBITOR_AUTO_CATALOG_PATH!, 'utf8')) as { services: unknown[] };

    expect(parsed.services).toEqual([legacy]);
  });

  it('clone が削除されたら stale な develop 派生も除去する', async () => {
    const clonePath = join(root, 'develop', 'Concordia');
    mkdirSync(clonePath, { recursive: true });
    const catalog = { services: [service()] } as unknown as Catalog;
    await runScan(catalog);

    rmSync(clonePath, { recursive: true, force: true });
    await runScan(catalog);
    const parsed = load(readFileSync(process.env.EXCUBITOR_AUTO_CATALOG_PATH!, 'utf8')) as { services: unknown[] };

    expect(parsed.services).toEqual([]);
  });
});
