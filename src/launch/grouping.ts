/**
 * catalog のサービスを project 単位でまとめ、 起動セット選択 UI 用の plan に整形する (pure)。
 * DB 非依存 — state は呼び出し側が code→state の map で渡す。
 */

import { type Service, type Tier, serviceTier } from '../catalog/loader.js';
import { startTier } from './order.js';

const STARTABLE_RUNTIMES = new Set(['docker-compose', 'node', 'dev-process-md']);

export interface PlanService {
  code: string;
  name: string;
  disabled: boolean;
  description: string | null;
  project_code: string;
  component: string | null;
  runtime: string;
  /** デプロイ/挙動クラス (saas / infra / personal / local-app)。 SaaS ランチャーの絞り込み軸。 */
  tier: Tier;
  port: number | null;
  frontend_port: number | null;
  backend_port: number | null;
  ports: Array<{ role: string; port: number; env?: string | null }>;
  frontend_url: string | null;
  subdomain: string | null;
  domain: string | null;
  monitor_only: boolean;
  /** Excubitor が起動制御できる runtime か (raw docker は未対応)。 */
  startable: boolean;
  start_tier: number;
  state: string;
  selected: boolean;
  /** Vestigium JSONL ログを持つか (catalog.log_path 設定済み)。 */
  has_vestigium: boolean;
  /** Vestigium ログディレクトリ (あれば)。 */
  log_path: string | null;
  /** boot 時に自動起動するか。 */
  autostart: boolean;
  allow_hot_reload: boolean;
  /** 既存 start-<service>.bat 等の起動スクリプトで起動するか (あればパス)。 */
  start_script: string | null;
  /** Launcher start 時に先に含めるサービスコード。 */
  depends_on: string[];
  /** 実効 uses_corpus (catalog デフォルト ← service_prefs override)。 */
  uses_corpus: boolean;
}

export interface PlanProject {
  project_code: string;
  services: PlanService[];
}

export function buildPlanProjects(
  services: Service[],
  stateByCode: Map<string, string>,
  selection: Set<string>,
  filterTiers?: Set<Tier>,
  usesCorpusByCode?: Map<string, boolean>,
): PlanProject[] {
  const byProject = new Map<string, PlanService[]>();
  for (const svc of services) {
    if (filterTiers && !filterTiers.has(serviceTier(svc))) continue;
    const project = svc.project_code ?? svc.code;
    const entry: PlanService = {
      code: svc.code,
      name: svc.name,
      disabled: svc.disabled,
      description: svc.description ?? null,
      project_code: project,
      component: svc.component ?? null,
      runtime: svc.runtime,
      tier: serviceTier(svc),
      port: svc.port ?? null,
      frontend_port: svc.frontend_port ?? null,
      backend_port: svc.backend_port ?? null,
      ports: svc.ports ?? [],
      frontend_url: svc.frontend_url ?? null,
      subdomain: svc.subdomain ?? null,
      domain: svc.domain ?? null,
      monitor_only: svc.monitor_only,
      startable: !svc.disabled && STARTABLE_RUNTIMES.has(svc.runtime),
      start_tier: startTier(svc),
      state: stateByCode.get(svc.code) ?? 'unknown',
      selected: selection.has(svc.code),
      has_vestigium: Boolean(svc.log_path),
      log_path: svc.log_path ?? null,
      autostart: svc.autostart,
      allow_hot_reload: svc.allow_hot_reload,
      start_script: svc.start_script ?? null,
      depends_on: svc.depends_on ?? [],
      uses_corpus: usesCorpusByCode?.get(svc.code) ?? svc.uses_corpus ?? false,
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
