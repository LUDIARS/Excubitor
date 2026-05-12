import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'js-yaml';
import { z } from 'zod';

const HealthSchema = z.object({
  type: z.enum(['http', 'tcp', 'cmd']),
  url: z.string().optional(),
  interval_sec: z.number().default(30),
  grace_period_sec: z.number().default(10),
});

const LogSourceSchema = z.union([
  z.object({ docker: z.string() }),
  z.object({ file: z.string() }),
  z.object({ process: z.enum(['stdout', 'stderr', 'both']) }),
]);

const InfisicalSchema = z.object({
  project_id: z.string(),
  environment: z.string(),
  inject: z.boolean().default(false),
  prefix: z.string().default(''),
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
});

/**
 * 自動修正設定。
 * - enabled: true で error_task 作成時に Claude Code CLI を自動起動
 * - max_auto_attempts: 1 error_task に対する自動 trigger の回数上限 (default 1 で人間判断へ)
 * - working_dir: claude を spawn する cwd。 省略時は catalog.cwd か compose_file の dir
 * - branch_prefix: 切る branch 名の prefix (default "excubitor/auto-fix/")
 * - create_pr: true で gh pr create まで実行
 */
const AutoFixSchema = z.object({
  enabled: z.boolean().default(false),
  agent: z.enum(['claude-code']).default('claude-code'),
  max_auto_attempts: z.number().int().positive().default(3),
  working_dir: z.string().optional(),
  branch_prefix: z.string().default('excubitor/auto-fix/'),
  create_pr: z.boolean().default(true),
  pr_draft: z.boolean().default(true),
  prompt_extra: z.string().optional(),
});

const ServiceSchema = z.object({
  code: z.string(),
  name: z.string(),
  /**
   * 論理サービス (LUDIARS の 1 プロジェクト) を表す識別子。
   * 同じ project_code を持つ catalog entry を UI で集約表示する。
   * 例: cernere-backend / cernere-frontend は project_code: "cernere"。
   */
  project_code: z.string().optional(),
  /** "backend" | "frontend" | "db" | "worker" などの役割タグ。 */
  component: z.string().optional(),
  /** 主要 listening port (host から見える側)。 */
  port: z.number().int().optional(),
  /**
   * true のとき version / git 情報の取得をスキップ (infra の DB 等、 ソースを管理してない対象向け)。
   */
  monitor_only: z.boolean().default(false),
  repo: z.string().optional(),
  runtime: z.enum(['docker-compose', 'docker', 'node', 'dev-process-md']),
  cwd: z.string().optional(),
  command: z.string().optional(),
  compose_file: z.string().optional(),
  services: z.array(z.string()).optional(),
  /**
   * docker scanner が container と紐付けるための名前パターン。
   * - runtime=docker-compose の場合、 compose の container_name もしくは
   *   `<project>-<service>` 形式の実コンテナ名を列挙する。
   * - runtime=docker の場合、 直接 container_name を列挙。
   * - 省略時は scanner は名前一致を試みない (= state は unknown のままになる)。
   */
  container_names: z.array(z.string()).optional(),
  autostart: z.boolean().default(false),
  restart_policy: z.enum(['no', 'on-failure', 'always']).default('no'),
  max_restart: z.number().default(5),
  health: HealthSchema.optional(),
  log_sources: z.array(LogSourceSchema).optional(),
  infisical: InfisicalSchema.optional(),
  auto_fix: AutoFixSchema.optional(),
});

const CatalogSchema = z.object({
  services: z.array(ServiceSchema),
});

export type Service = z.infer<typeof ServiceSchema>;
export type Catalog = z.infer<typeof CatalogSchema>;

export function loadCatalog(path = 'catalog/services.yaml'): Catalog {
  const absPath = resolve(process.cwd(), path);
  const raw = readFileSync(absPath, 'utf8');
  const parsed = load(raw);
  return CatalogSchema.parse(parsed);
}
