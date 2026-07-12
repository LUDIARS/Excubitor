import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'js-yaml';
import { z } from 'zod';
import { readAutoServicesRaw } from './auto-catalog-file.js';
import { arsRoot, domainRoot } from '../shared/roots.js';

const HealthSchema = z.object({
  // process: 管理下プロセスの pid 生存で死活を判定 (port を持たないローカルアプリ向け)。
  type: z.enum(['http', 'tcp', 'cmd', 'process']),
  url: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
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
  required_env: z.array(z.string()).optional(),
});

/**
 * 他サービスの Infisical project から NAMED secret を借りる設定 (cross-service delegation)。
 * 例: aedilis が cernere 発行のクライアント資格情報を必要とするケース。
 * `keys` で列挙したキーのみを取得する (source の secret 全量へは絶対にアクセスさせない)。
 */
const RequiresSecretSchema = z.object({
  service: z.string(),
  keys: z.array(z.string()).min(1),
});

/** Cernereに起動対象projectのcredentialをspawn直前発行させる設定。 */
const CernereLaunchCredentialsSchema = z.object({
  target_project: z.string().min(1),
  issuer_client_id_env: z.string().default('EXCUBITOR_CERNERE_CLIENT_ID'),
  issuer_client_secret_env: z.string().default('EXCUBITOR_CERNERE_CLIENT_SECRET'),
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

/**
 * メモリ監視設定 (per service)。 省略時は enabled=true で外形 RSS のみ監視する。
 * - metrics_url: Tier2 (heap 内訳)。 サービスが process.memoryUsage() 相当を JSON で返す
 *   エンドポイント (例 http://localhost:5180/api/metrics/memory)。 設定したサービスのみ heap/external を取得。
 * - leak_window_min: リーク判定の観測窓 (分)。 この窓の RSS 時系列で slope を測る。
 * - leak_threshold_mb_per_hr: この傾き (MB/時) を超え かつ 単調増加なら leak と判定し error_task を起こす。
 */
const MemoryMonitorServiceSchema = z.object({
  enabled: z.boolean().default(true),
  metrics_url: z.string().optional(),
  rss_budget_mb: z.number().positive().optional(),
  cpu_budget_pct: z.number().positive().optional(),
  leak_window_min: z.number().positive().default(60),
  leak_threshold_mb_per_hr: z.number().positive().default(50),
  /** CPU 高止まりアラートの per-service 上書き (省略時は cpu_alert グローバル値)。 */
  cpu_threshold_pct: z.number().positive().optional(),
  cpu_window_min: z.number().positive().optional(),
});

const ManagedPortSchema = z.object({
  role: z.string().default('service'),
  port: z.number().int(),
  env: z.string().optional(),
});

const ProjectVersionSchema = z.object({
  major: z.number().int().nonnegative(),
  minor: z.number().int().nonnegative(),
});

const ServiceSchema = z.object({
  code: z.string(),
  name: z.string(),
  disabled: z.boolean().default(false),
  description: z.string().optional(),
  /**
   * デプロイ/挙動クラス。 ローカルアプリ と SaaS で Excubitor の扱いを分けるための分類。
   * - saas      : 多人数向けにデプロイするバックエンド Web サービス (SaaS ランチャーが管理)
   * - infra     : LUDIARS 共有インフラ (infra/ リポの DB / queue / object store 等)
   * - personal  : 本人の PC でのみ動く単独利用ツール (Memoria local / Concordia 等)
   * - local-app : ネイティブ/デスクトップ製品 (runtime=app、 Tauri / Electron / native)
   * 未指定時は serviceTier() が runtime / project から推定する (既定 saas)。
   */
  tier: z.enum(['saas', 'infra', 'personal', 'local-app']).optional(),
  /**
   * 論理サービス (LUDIARS の 1 プロジェクチE を表す識別子、E
   * 同じ project_code を持つ catalog entry めEUI で雁E��E��示する、E
   * 侁E cernere-backend / cernere-frontend は project_code: "cernere"、E
   */
  project_code: z.string().optional(),
  /** develop clone から生成された派生サービス。 */
  develop_derived: z.boolean().default(false),
  /** develop 派生元の catalog code。ポート共有ペアの識別にも使う。 */
  develop_from: z.string().optional(),
  /** "backend" | "frontend" | "db" | "worker" などの役割タグ、E*/
  component: z.string().optional(),
  /** 主要Elistening port (host から見える�E)、E*/
  port: z.number().int().optional(),
  frontend_port: z.number().int().optional(),
  backend_port: z.number().int().optional(),
  ports: z.array(ManagedPortSchema).optional(),
  frontend_url: z.string().optional(),
  subdomain: z.string().optional(),
  domain: z.string().optional(),
  /**
   * true のとぁEversion / git 惁E��の取得をスキチE�E (infra の DB 等、Eソースを管琁E��てなぁE��象向け)、E
   */
  monitor_only: z.boolean().default(false),
  repo: z.string().optional(),
  /**
   * - docker-compose / docker: コンテナ
   * - node: `command` を spawn する常駐サービス (port を持つ)
   * - dev-process-md: cwd の dev-process.md から起動コマンドを解決
   * - app: **ローカルアプリ (プロダクト)**。 port を持たないネイティブ/デスクトップ製品
   *   (Tauri / Electron / native exe / CLI バイナリ)。 `exec` で起動し、 死活は
   *   プロセス生存で判定、 既定では自動 respawn しない (GUI を勝手に再起動しない)。
   */
  runtime: z.enum(['docker-compose', 'docker', 'node', 'dev-process-md', 'app']),
  cwd: z.string().optional(),
  command: z.string().optional(),
  /**
   * 起動スクリプト (.bat / .sh / .cmd) の絶対パス。 設定すると runtime=node/dev-process-md の
   * `command` より優先してこのスクリプトを spawn する。 既存の start-<service>.bat
   * (git pull → 関連リポ build → npm run dev) をそのまま Excubitor から「ウィンドウ無し」で
   * 起動するための口。 cwd 省略時はスクリプトのあるディレクトリで実行する。
   * 例: start_script: ${ARS_ROOT}/start-concordia.bat
   */
  start_script: z.string().optional(),
  compose_file: z.string().optional(),
  services: z.array(z.string()).optional(),
  depends_on: z.array(z.string()).default([]),
  /**
   * docker scanner ぁEcontainer と紐付けるため�E名前パターン、E
   * - runtime=docker-compose の場合、Ecompose の container_name もしく�E
   *   `<project>-<service>` 形式�E実コンチE��名を列挙する、E
   * - runtime=docker の場合、E直接 container_name を�E挙、E
   * - 省略時�E scanner は名前一致を試みなぁE(= state は unknown のままになめE、E
   */
  container_names: z.array(z.string()).optional(),
  autostart: z.boolean().default(false),
  // Hot-reload/watch/dev-server commands are blocked by default. Opt in per service only when needed.
  allow_hot_reload: z.boolean().default(false),
  restart_policy: z.enum(['no', 'on-failure', 'always']).default('no'),
  max_restart: z.number().default(5),
  health: HealthSchema.optional(),
  log_sources: z.array(LogSourceSchema).optional(),
  /**
   * Vestigium が吐ぁEJSONL ログのチE��レクトリ、E
   * 設定があれば observability は file-tail でこちらを読み、E
   * 旧 process-bridge (spawn ↁEstdout capture) より優先する、E
   * 例: `${ARS_ROOT}/logs/cernere`
   */
  log_path: z.string().optional(),
  /**
   * Infisical secret 注入設定。 設定があると Excubitor が起動時に該当 project の
   * secret を fetch し、 spawn する子プロセスの env にリレーする (各サービス自前 fetch を不要にする)。
   */
  infisical: InfisicalSchema.optional(),
  /**
   * 他サービスの Infisical project から NAMED secret を借りる (cross-service delegation)。
   * 各エントリの `service` (catalog code) が持つ `infisical` 設定から `keys` のみを取得し、
   * このサービスの spawn env に最優先でマージする。 例:
   *   requires_secret:
   *     - service: cernere
   *       keys: [AEDILIS_CERNERE_CLIENT_ID, AEDILIS_CERNERE_CLIENT_SECRET]
   */
  requires_secret: z.array(RequiresSecretSchema).optional(),
  /**
   * 起動ごとにCernereへcredential発行を要求し、返却値を子プロセスenvへ注入する。
   * issuer credentialはEx内部でだけ消費し、spawn子には渡さない。
   */
  cernere_launch_credentials: CernereLaunchCredentialsSchema.optional(),
  /**
   * このサービスが他サービスへ公開する topology env (URL/port 等)。
   * Excubitor が catalog から導出して全サービスの spawn env に注入する。
   * value テンプレートで `${port}` / `${host}` を展開する。
   * 例 (cernere-backend-dev):
   *   provides:
   *     CERNERE_URL: http://localhost:${port}
   *     CERNERE_WS_URL: ws://localhost:${port}
   * これで各サービスは CERNERE_URL を自前設定せずに受け取れる。
   */
  provides: z.record(z.string(), z.string()).optional(),
  /**
   * このサービス自身の spawn 時に注入する静的 env (非 secret)。 topology より優先、 secret より低優先。
   * サービス固有の port / フラグ等を catalog 1 箇所で固定したいとき (= Excubitor 内で完結) に使う。
   * 例 (discutere の port 競合回避): env: { BACKEND_PORT: "3110" }
   */
  env: z.record(z.string(), z.string()).optional(),
  /** 起動前に空値を許容しない env 名。Infisical required_env/include と合算して検査する。 */
  required_env: z.array(z.string()).default([]),
  /**
   * runtime=app 専用。 起動する実行ファイル (絶対パス推奨) と引数。
   * 例: exec: ${ARS_ROOT}/Hora/src-tauri/target/release/hora.exe
   * dev 起動 (npm run tauri dev 等) は runtime=node + command で表現する。
   */
  exec: z.string().optional(),
  exec_args: z.array(z.string()).optional(),
  /** UI / Corpus 表示用の分類。 起動方式自体には影響しない。 */
  app_kind: z.enum(['tauri', 'electron', 'native', 'cli']).optional(),
  /**
   * このサービスが Corpus (大規模 Hub) をフロント/連携基盤として利用するか。
   * - true  : Corpus 経由でフロントを統合する。 このサービスを起動セットに含めると
   *           orchestrator が Corpus も自動で起動セットに加える (Corpus を先に立てる)。
   * - false : Corpus に依存しない単独サービス (自前フロント / バックエンド単独)。
   * catalog がデフォルト値。 UI から service_prefs (DB) で上書きできる
   * (= 「Corpus を使うケース / 使わないケースを設定できる」 の実体)。 省略時は false。
   */
  uses_corpus: z.boolean().optional(),
  /**
   * runtime=app の更新適用 (update apply) で git ff の後に走らせるビルドコマンド。
   * node の `npm install` 相当。 例: 'cargo build --release' / 'npm run build'。
   * 省略時はビルドせず取り込みのみ。
   */
  build_command: z.string().optional(),
  /**
   * host プロセススキャンで「ユーザが Excubitor 外から起動した実体」を検知するための
   * 実行ファイル名 (image name)。 例: 'hora.exe'。 省略時は Excubitor が spawn した
   * インスタンスのみ追跡する。 (host scanner 未対応の間は予約フィールド)
   */
  process_match: z.string().optional(),
  auto_fix: AutoFixSchema.optional(),
  /** メモリ監視設定。 省略時は外形 RSS のみ (Tier1) で監視する。 */
  memory: MemoryMonitorServiceSchema.optional(),
});

/**
 * WSL バックエンドのメモリ監視設定 (catalog top-level)。
 * WSL2 は全 distro が 1 つの軽量 VM (Windows 側 vmmem プロセス) を共有するため、
 * サービス単位ではなく distro / vmmem 単位で別軸監視する。
 */
const WslMonitorSchema = z.object({
  enabled: z.boolean().default(true),
  /** 監視する distro 名。 空なら `wsl -l -q` で自動検出 (docker-desktop 系は除外)。 */
  distros: z.array(z.string()).default([]),
  leak_window_min: z.number().positive().default(120),
  leak_threshold_mb_per_hr: z.number().positive().default(200),
});

/**
 * CPU 高止まりアラート設定 (catalog top-level)。 leak (メモリ) とは別軸。
 * 観測窓内で threshold_pct 以上のサンプルが sustained_ratio を超えたら error_task 起票。
 * 瞬間スパイクで起票しないよう「継続している割合」で判定する。
 */
const CpuAlertSchema = z.object({
  enabled: z.boolean().default(true),
  threshold_pct: z.number().positive().default(85),
  window_min: z.number().positive().default(15),
  sustained_ratio: z.number().min(0).max(1).default(0.8),
  min_samples: z.number().positive().default(8),
});

/** メモリ監視のグローバル設定 (catalog top-level、 省略時は既定値)。 */
const MemoryGlobalSchema = z.object({
  enabled: z.boolean().default(true),
  interval_sec: z.number().positive().default(60),
  retention_hours: z.number().positive().default(48),
  default_service_rss_budget_mb: z.number().positive().default(1024),
  default_service_cpu_budget_pct: z.number().positive().default(80),
  wsl: WslMonitorSchema.default({}),
  cpu_alert: CpuAlertSchema.default({}),
});

const GlobalSchema = z.object({
  /** 全サービス共通で注入する env。 サービス固有 env / secret より低優先。 */
  env: z.record(z.string(), z.string()).optional(),
});

/** 構造化履歴と Parquet ログの保持設定。 */
const RetentionSchema = z.object({
  enabled: z.boolean().default(true),
  /** Phase 4 の設定掃除まで受理する旧ログ保持時間。 Phase 1 以降は使用しない。 */
  logs_hours: z.number().positive().default(72),
  /** liveness_history (死活履歴) の保持時間。 */
  liveness_hours: z.number().positive().default(168),
  /** 圧縮済み Parquet ログの保持日数。 */
  parquet_days: z.number().int().positive().default(90),
  /** 剪定周期 (分)。 */
  interval_min: z.number().positive().default(60),
  /** 1 バッチの削除行数上限 (書き込みロックの長期保持回避)。 */
  batch_rows: z.number().int().positive().default(50_000),
});

/** ライブリングと日次圧縮の設定。 */
const LogStoreSchema = z.object({
  ring_lines_per_service: z.number().int().positive().default(2_000),
  ring_lines_global: z.number().int().positive().default(20_000),
  compact_hour_utc: z.number().int().min(0).max(23).default(18),
});

const CatalogSchema = z.object({
  project_versions: z.record(ProjectVersionSchema).default({}),
  services: z.array(ServiceSchema),
  /** カタログ全体に適用するグローバル設定。 */
  global: GlobalSchema.optional(),
  /** メモリ監視のグローバル設定 (interval / 保持期間 / WSL)。 */
  memory_monitor: MemoryGlobalSchema.default({}),
  /** 構造化履歴と Parquet ログの保持期間。 */
  retention: RetentionSchema.default({}),
  /** ログのライブ保持と日次圧縮。 */
  log_store: LogStoreSchema.default({}),
});

export type Service = z.infer<typeof ServiceSchema>;
export type Catalog = z.infer<typeof CatalogSchema>;
export type RequiresSecret = z.infer<typeof RequiresSecretSchema>;

export type Tier = 'saas' | 'infra' | 'personal' | 'local-app';

/** 表示順 (SaaS ランチャー → infra → personal → local-app)。 */
export const TIER_ORDER: Tier[] = ['saas', 'infra', 'personal', 'local-app'];

/**
 * サービスの tier を解決する。 catalog で明示されていればそれを使い、
 * 無ければ runtime から推定する (runtime=app → local-app、 それ以外 → saas)。
 * infra / personal は曖昧さがあるため catalog 明示を推奨 (推定は saas 既定に倒す)。
 */
export function serviceTier(svc: Service): Tier {
  if (svc.tier) return svc.tier;
  if (svc.runtime === 'app') return 'local-app';
  return 'saas';
}

export function loadCatalog(path = 'catalog/services.yaml'): Catalog {
  const absPath = resolve(process.cwd(), path);
  const raw = readFileSync(absPath, 'utf8');
  // ${ARS_ROOT} / ${DOMAIN_ROOT} をマシン依存の実値に補間してから parse する
  // (catalog にドライブ/ドメインを焼き込まず、 env or cwd の親から解決する)。
  const interpolated = raw
    .replaceAll('${ARS_ROOT}', arsRoot())
    .replaceAll('${DOMAIN_ROOT}', domainRoot());
  const parsed = (load(interpolated) ?? {}) as { services?: unknown[]; [k: string]: unknown };
  const baseServices = Array.isArray(parsed.services) ? parsed.services : [];

  // スキャンが生成した自動カタログをマージする。 手書き services.yaml に同 code が
  // あれば手書きを優先 (auto を捨てる)。 不正な auto エントリは個別に弾く (全体を壊さない)。
  const baseCodes = new Set(
    baseServices.map((s) => (s as { code?: unknown }).code).filter((c): c is string => typeof c === 'string'),
  );
  const autoServices: unknown[] = [];
  for (const entry of readAutoServicesRaw()) {
    const code = (entry as { code?: unknown }).code;
    if (typeof code !== 'string' || baseCodes.has(code)) continue;
    if (ServiceSchema.safeParse(entry).success) autoServices.push(entry);
  }

  return CatalogSchema.parse({ ...parsed, services: [...baseServices, ...autoServices] });
}



