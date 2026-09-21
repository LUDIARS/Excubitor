import { describe, expect, it } from 'vitest';
import type { Service } from '../catalog/loader.js';
import { coverageKind, resolveCoverage } from './coverage.js';

function svc(p: Partial<Service> & { code: string }): Service {
  return { name: p.code, disabled: false, runtime: 'node', ...p } as Service;
}

describe('coverageKind', () => {
  it('treats anything this node can launch as managed', () => {
    expect(coverageKind(svc({ code: 'a', command: 'npm run dev' }))).toBe('managed');
    expect(coverageKind(svc({ code: 'b', start_script: 'C:/x/start.bat' }))).toBe('managed');
    expect(coverageKind(svc({ code: 'c', compose_file: 'C:/x/compose.yaml' }))).toBe('managed');
    expect(coverageKind(svc({ code: 'd', exec: 'C:/x/app.exe' }))).toBe('managed');
  });

  it('treats watch-only entries as observed', () => {
    expect(coverageKind(svc({ code: 'excubitor' }))).toBe('observed');
  });
});

describe('resolveCoverage', () => {
  const services = [
    svc({ code: 'zeta', command: 'run' }),
    svc({ code: 'alpha', project_code: 'Al' }),
    svc({ code: 'off', command: 'run', disabled: true }),
  ];

  it('covers every enabled catalog service by default, sorted by code', () => {
    expect(resolveCoverage(services, new Map())).toEqual([
      { code: 'alpha', name: 'alpha', project_code: 'Al', kind: 'observed', covered: true, source: 'catalog' },
      { code: 'zeta', name: 'zeta', project_code: null, kind: 'managed', covered: true, source: 'catalog' },
    ]);
  });

  it('applies this node\'s overrides', () => {
    const coverage = resolveCoverage(services, new Map([['zeta', false]]));
    expect(coverage.find((c) => c.code === 'zeta')).toMatchObject({ covered: false, source: 'override' });
  });
});
