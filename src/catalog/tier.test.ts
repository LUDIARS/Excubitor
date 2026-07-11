import { describe, it, expect } from 'vitest';
import { loadCatalog, serviceTier, type Service } from './loader.js';
import { buildPlanProjects } from '../launch/grouping.js';
import { matchProcesses } from '../scanner/host-process.js';

function svc(partial: Partial<Service> & Pick<Service, 'code' | 'runtime'>): Service {
  return {
    name: partial.name ?? partial.code,
    monitor_only: false,
    autostart: false,
    restart_policy: 'no',
    max_restart: 5,
    ...partial,
  } as Service;
}

describe('serviceTier', () => {
  it('明示 tier をそのまま返す', () => {
    expect(serviceTier(svc({ code: 'a', runtime: 'node', tier: 'personal' }))).toBe('personal');
    expect(serviceTier(svc({ code: 'b', runtime: 'docker-compose', tier: 'infra' }))).toBe('infra');
  });

  it('未指定: runtime=app は local-app、 それ以外は saas に倒す', () => {
    expect(serviceTier(svc({ code: 'app', runtime: 'app' }))).toBe('local-app');
    expect(serviceTier(svc({ code: 'n', runtime: 'node' }))).toBe('saas');
  });
});

describe('buildPlanProjects tier filter', () => {
  const services = [
    svc({ code: 'cernere', runtime: 'docker-compose', project_code: 'cernere', tier: 'saas' }),
    svc({ code: 'infra-pg', runtime: 'docker-compose', project_code: 'infra', tier: 'infra' }),
    svc({ code: 'concordia', runtime: 'node', project_code: 'concordia', tier: 'personal' }),
    svc({ code: 'hora-app', runtime: 'app', project_code: 'hora', tier: 'local-app' }),
  ];

  it('filter 無しは全 tier を返す', () => {
    const projects = buildPlanProjects(services, new Map(), new Set());
    expect(projects.flatMap((p) => p.services).length).toBe(4);
  });

  it('saas+infra に絞ると personal / local-app は除外され空プロジェクトは消える', () => {
    const projects = buildPlanProjects(services, new Map(), new Set(), new Set(['saas', 'infra']));
    const codes = projects.flatMap((p) => p.services).map((s) => s.code).sort();
    expect(codes).toEqual(['cernere', 'infra-pg']);
  });

  it('PlanService に tier が載る', () => {
    const projects = buildPlanProjects(services, new Map(), new Set());
    const hora = projects.flatMap((p) => p.services).find((s) => s.code === 'hora-app');
    expect(hora?.tier).toBe('local-app');
  });
});

describe('matchProcesses', () => {
  it('process_match の image 名 (大文字小文字無視) で一致を返す', () => {
    const targets = [
      { code: 'hora-app', process_match: 'hora.exe' },
      { code: 'other', process_match: 'other.exe' },
      { code: 'no-match-field', process_match: undefined },
    ];
    const alive = matchProcesses(targets, new Set(['Hora.exe', 'explorer.exe']));
    expect(alive.has('hora-app')).toBe(true);
    expect(alive.has('other')).toBe(false);
    expect(alive.has('no-match-field')).toBe(false);
  });
});

describe('catalog (services.yaml)', () => {
  const catalog = loadCatalog();

  it('フロントエンドは catalog から除外されている', () => {
    const frontends = catalog.services.filter((s) => s.component === 'frontend');
    expect(frontends.map((s) => s.code).sort()).toEqual(['concordia-web', 'praeforma-web']);
    expect(catalog.services.find((s) => s.code === 'cernere-frontend-dev')).toBeUndefined();
    expect(catalog.services.find((s) => s.code === 'actio-frontend')).toBeUndefined();
  });

  it('-backend サービスは純粋名にリネーム済 (cernere / actio)', () => {
    expect(catalog.services.find((s) => s.code === 'cernere')).toBeDefined();
    expect(catalog.services.find((s) => s.code === 'actio')).toBeDefined();
    expect(catalog.services.find((s) => s.code === 'cernere-backend-dev')).toBeUndefined();
    expect(catalog.services.find((s) => s.code === 'actio-backend')).toBeUndefined();
  });

  it('全サービスに tier が解決できる', () => {
    for (const s of catalog.services) {
      expect(['saas', 'infra', 'personal', 'local-app']).toContain(serviceTier(s));
    }
  });

  it('discutere の port は nuntius (3100) と競合せず env で整合する', () => {
    const di = catalog.services.find((s) => s.code === 'discutere');
    const nuntius = catalog.services.find((s) => s.code === 'nuntius-api');
    expect(di?.port).toBe(3110);
    expect(nuntius?.port).toBe(3100);
    expect(di?.env?.BACKEND_PORT).toBe('3110');
  });

  it('registers Calliope on its canonical port with its upstream dependencies', () => {
    const calliope = catalog.services.find((s) => s.code === 'calliope');
    expect(calliope).toMatchObject({
      port: 8891,
      project_code: 'calliope',
      runtime: 'node',
      health: { type: 'http', url: 'http://localhost:8891/health' },
    });
    expect(calliope?.depends_on).toEqual(['actio', 'schedula', 'memoria-server']);
    expect(calliope?.env?.CALLIOPE_PORT).toBe('8891');
  });
});
