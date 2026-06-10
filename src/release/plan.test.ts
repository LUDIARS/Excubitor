import { describe, it, expect } from 'vitest';
import { planRelease, bundleSubdirFor } from './plan.js';
import { parseReleaseManifest } from './manifest.js';
import type { Catalog } from '../catalog/loader.js';

describe('bundleSubdirFor', () => {
  it('primary は app、 それ以外は packages/<code>', () => {
    expect(bundleSubdirFor({ code: 'a', role: 'primary' } as never)).toBe('app');
    expect(bundleSubdirFor({ code: 'lictor', role: 'cli' } as never)).toBe('packages/lictor');
    expect(bundleSubdirFor({ code: 'canalis', role: 'lib' } as never)).toBe('packages/canalis');
  });
});

describe('planRelease', () => {
  it('build 順は lib/cli が先、 primary が最後', () => {
    const m = parseReleaseManifest({
      name: 'demo',
      primary: 'app',
      components: [
        { code: 'app', role: 'primary', path: process.cwd() },
        { code: 'lib1', role: 'lib', path: process.cwd() },
      ],
    });
    const plan = planRelease(m, null);
    expect(plan.buildOrder.map((c) => c.component.code)).toEqual(['lib1', 'app']);
  });

  it('path も catalog も無いと errors を出す', () => {
    const m = parseReleaseManifest({
      name: 'demo',
      primary: 'app',
      components: [{ code: 'app', role: 'primary' }],
    });
    const plan = planRelease(m, null);
    expect(plan.errors.some((e) => e.includes('repo パス未解決'))).toBe(true);
  });

  it('path 未指定でも catalog の同 code から repo を解決する', () => {
    const catalog = {
      services: [{ code: 'app', name: 'app', runtime: 'node', cwd: process.cwd() }],
    } as unknown as Catalog;
    const m = parseReleaseManifest({
      name: 'demo',
      primary: 'app',
      components: [{ code: 'app', role: 'primary' }],
    });
    const plan = planRelease(m, catalog);
    expect(plan.errors).toEqual([]);
    expect(plan.components[0]!.repoDir).toBe(process.cwd());
  });
});
