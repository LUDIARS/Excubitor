/**
 * マニフェスト → ビルド計画。 各 component の repo パスを解決し、 バンドル内の
 * 配置先 (app / packages/<code>) と build 順序を決める。 実ビルドは行わない (純関数)。
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Catalog } from '../catalog/loader.js';
import { repoDirOf } from '../update/checker.js';
import type { Component, ReleaseManifest } from './manifest.js';

export interface ResolvedComponent {
  component: Component;
  /** 解決後の絶対 repo パス (解決不能なら '')。 */
  repoDir: string;
  /** バンドル内の配置先。 primary→"app"、 それ以外→"packages/<code>"。 */
  bundleSubdir: string;
}

export interface ReleasePlan {
  manifest: ReleaseManifest;
  components: ResolvedComponent[];
  /** build 順序 (lib/cli を先に、 primary を最後に)。 */
  buildOrder: ResolvedComponent[];
  /** 解決できなかった理由 (空なら ok)。 */
  errors: string[];
}

/** primary は app/、 それ以外は packages/<code>/ に置く。 */
export function bundleSubdirFor(c: Component): string {
  return c.role === 'primary' ? 'app' : `packages/${c.code}`;
}

export function planRelease(manifest: ReleaseManifest, catalog: Catalog | null): ReleasePlan {
  const errors: string[] = [];

  const components: ResolvedComponent[] = manifest.components.map((component) => {
    let repoDir = component.path ?? null;
    if (!repoDir && catalog) {
      const svc = catalog.services.find((s) => s.code === component.code);
      repoDir = svc ? repoDirOf(svc) : null;
    }
    if (!repoDir) {
      errors.push(`component "${component.code}": repo パス未解決 (path 未指定かつ catalog に無い)`);
    }
    const abs = repoDir ? resolve(process.cwd(), repoDir) : '';
    if (abs && !existsSync(abs)) {
      errors.push(`component "${component.code}": repo dir が存在しない: ${abs}`);
    }
    return { component, repoDir: abs, bundleSubdir: bundleSubdirFor(component) };
  });

  const buildOrder = [
    ...components.filter((c) => c.component.role !== 'primary'),
    ...components.filter((c) => c.component.role === 'primary'),
  ];

  return { manifest, components, buildOrder, errors };
}
