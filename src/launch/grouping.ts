/**
 * catalog のサービスを project 単位でまとめ、 起動セット選択 UI 用の plan に整形する (pure)。
 * DB 非依存 — state は呼び出し側が code→state の map で渡す。
 */

import type { Service } from '../catalog/loader.js';
import { startTier } from './order.js';

const STARTABLE_RUNTIMES = new Set(['docker-compose', 'node', 'dev-process-md']);

export interface PlanService {
  code: string;
  name: string;
  project_code: string;
  component: string | null;
  runtime: string;
  port: number | null;
  monitor_only: boolean;
  /** Excubitor が起動制御できる runtime か (raw docker は未対応)。 */
  startable: boolean;
  start_tier: number;
  state: string;
  selected: boolean;
}

export interface PlanProject {
  project_code: string;
  services: PlanService[];
}

export function buildPlanProjects(
  services: Service[],
  stateByCode: Map<string, string>,
  selection: Set<string>,
): PlanProject[] {
  const byProject = new Map<string, PlanService[]>();
  for (const svc of services) {
    const project = svc.project_code ?? svc.code;
    const entry: PlanService = {
      code: svc.code,
      name: svc.name,
      project_code: project,
      component: svc.component ?? null,
      runtime: svc.runtime,
      port: svc.port ?? null,
      monitor_only: svc.monitor_only,
      startable: STARTABLE_RUNTIMES.has(svc.runtime),
      start_tier: startTier(svc),
      state: stateByCode.get(svc.code) ?? 'unknown',
      selected: selection.has(svc.code),
    };
    const arr = byProject.get(project) ?? [];
    arr.push(entry);
    byProject.set(project, arr);
  }
  return Array.from(byProject.entries()).map(([project_code, svcs]) => ({
    project_code,
    services: svcs,
  }));
}
