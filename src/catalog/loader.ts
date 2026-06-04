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
 * 自動修正設定、E
 * - enabled: true で error_task 作�E時に Claude Code CLI を�E動起勁E
 * - max_auto_attempts: 1 error_task に対する自勁Etrigger の回数上限 (default 1 で人間判断へ)
 * - working_dir: claude めEspawn する cwd、E省略時�E catalog.cwd ぁEcompose_file の dir
 * - branch_prefix: 刁E�� branch 名�E prefix (default "excubitor/auto-fix/")
 * - create_pr: true で gh pr create まで実衁E
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
   * 論理サービス (LUDIARS の 1 プロジェクチE を表す識別子、E
   * 同じ project_code を持つ catalog entry めEUI で雁E��E��示する、E
   * 侁E cernere-backend / cernere-frontend は project_code: "cernere"、E
   */
  project_code: z.string().optional(),
  /** "backend" | "frontend" | "db" | "worker" などの役割タグ、E*/
  component: z.string().optional(),
  /** 主要Elistening port (host から見える�E)、E*/
  port: z.number().int().optional(),
  /**
   * true のとぁEversion / git 惁E��の取得をスキチE�E (infra の DB 等、Eソースを管琁E��てなぁE��象向け)、E
   */
  monitor_only: z.boolean().default(false),
  repo: z.string().optional(),
  runtime: z.enum(['docker-compose', 'docker', 'node', 'dev-process-md']),
  cwd: z.string().optional(),
  command: z.string().optional(),
  compose_file: z.string().optional(),
  services: z.array(z.string()).optional(),
  /**
   * docker scanner ぁEcontainer と紐付けるため�E名前パターン、E
   * - runtime=docker-compose の場合、Ecompose の container_name もしく�E
   *   `<project>-<service>` 形式�E実コンチE��名を列挙する、E
   * - runtime=docker の場合、E直接 container_name を�E挙、E
   * - 省略時�E scanner は名前一致を試みなぁE(= state は unknown のままになめE、E
   */
  container_names: z.array(z.string()).optional(),
  autostart: z.boolean().default(false),
  restart_policy: z.enum(['no', 'on-failure', 'always']).default('no'),
  max_restart: z.number().default(5),
  health: HealthSchema.optional(),
  log_sources: z.array(LogSourceSchema).optional(),
  /**
   * Vestigium が吐ぁEJSONL ログのチE��レクトリ、E
   * 設定があれば observability は file-tail でこちらを読み、E
   * 旧 process-bridge (spawn ↁEstdout capture) より優先する、E
   * 侁E `E:/Document/Ars/logs/cernere`
   */
  log_path: z.string().optional(),
  /**
   * Infisical secret 注入設定。 設定があると Excubitor が起動時に該当 project の
   * secret を fetch し、 spawn する子プロセスの env にリレーする (各サービス自前 fetch を不要にする)。
   */
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



