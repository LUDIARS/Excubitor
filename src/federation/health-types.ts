/**
 * 拠点間でやり取りする health 応答 (`GET /api/v1/federation/health`) の契約。
 *
 * 送る側 (node-health.ts) と受ける側 (peer-poller.ts) で同じ定義を使う。 受ける側では
 * 相手拠点の応答を信用せず、 このスキーマで検証してから cache に載せる。
 */

import { z } from 'zod';
import { OperationSummarySchema, UpdateSourceSchema } from './operations/types.js';

/** @implements SPEC-FEDERATION-HEALTH-CACHE */

/**
 * 応答形式の版。 互換性のない変更をしたら上げる。
 * 2: node_info (拠点情報) と operations (依頼の履歴) を追加、 リンク状態に unregistered を追加。
 */
export const FEDERATION_HEALTH_SCHEMA = 2;

/**
 * サービス 1 件の死活。
 * - up / down:   監視ループの probe 結果
 * - unmonitored: health 判定の手段が無い (not_configured)
 * - unknown:     起動直後でまだ 1 周も probe していない
 */
export const ServiceHealthStateSchema = z.enum(['up', 'down', 'unmonitored', 'unknown']);
export type ServiceHealthState = z.infer<typeof ServiceHealthStateSchema>;

export const NodeServiceHealthSchema = z.object({
  code: z.string(),
  name: z.string(),
  project_code: z.string().nullable(),
  kind: z.enum(['managed', 'observed']),
  covered: z.boolean(),
  source: z.enum(['catalog', 'override']),
  /** service_instances.state (running / stopped / pending ...)。 */
  state: z.string(),
  port: z.number().nullable(),
  git_branch: z.string().nullable(),
  startup: z.boolean().nullable().optional(),
  health: z.object({
    state: ServiceHealthStateSchema,
    reason: z.string().nullable(),
    detail: z.string().nullable(),
    checked_at: z.number().nullable(),
    reported_version: z.string().nullable(),
  }),
});
export type NodeServiceHealth = z.infer<typeof NodeServiceHealthSchema>;

/**
 * 拠点から見た他拠点へのつながり。
 * - up:           health を取得できた
 * - down:         接続できない / タイムアウト / 5xx / 応答が契約に合わない
 * - unauthorized: 401 / 403 (token の食い違い)
 * - unregistered: token は合っているが、 相手がこちらをピア登録していない (相互登録待ち)
 * - pending:      登録直後でまだ 1 回も問い合わせていない
 */
export const PeerLinkStatusSchema = z.enum(['up', 'down', 'unauthorized', 'unregistered', 'pending']);
export type PeerLinkStatus = z.infer<typeof PeerLinkStatusSchema>;

export const NodePeerLinkSchema = z.object({
  /** 相手拠点の名前 (相手が名乗った node 名。 未取得ならピア登録名)。 */
  node: z.string(),
  status: PeerLinkStatusSchema,
  latency_ms: z.number().nullable(),
  checked_at: z.number().nullable(),
  last_ok_at: z.number().nullable(),
  error: z.string().nullable(),
});
export type NodePeerLink = z.infer<typeof NodePeerLinkSchema>;

export const NodeSummarySchema = z.object({
  service: z.string().optional(),
  services_total: z.number(),
  up: z.number(),
  down: z.number(),
  unknown: z.number(),
  open_errors: z.number(),
});

/** 拠点情報 (node-info.ts)。 表示用で、 認可や判定には使わない。 */
export const NodeInfoSchema = z.object({
  node: z.string(),
  excubitor: z.object({
    version: z.string(),
    git_branch: z.string().nullable(),
    git_hash: z.string().nullable(),
    started_at: z.number(),
  }),
  platform: z.object({
    os: z.string(),
    release: z.string(),
    arch: z.string(),
    hostname: z.string(),
    node_version: z.string(),
  }),
  listener: z.object({
    enabled: z.boolean(),
    listening: z.array(z.string()),
    error: z.string().nullable(),
  }),
  peers: z.object({ registered: z.number(), enabled: z.number() }),
  services: z.object({ catalog_total: z.number(), covered: z.number(), managed: z.number() }),
  update_source: UpdateSourceSchema.nullable(),
});
export type NodeInfo = z.infer<typeof NodeInfoSchema>;

export const NodeHealthPayloadSchema = z.object({
  schema: z.literal(FEDERATION_HEALTH_SCHEMA),
  node: z.string().min(1),
  generated_at: z.number(),
  scan: z.object({
    started_at: z.number().nullable(),
    completed_at: z.number().nullable(),
    duration_ms: z.number().nullable(),
    interval_ms: z.number().nullable(),
  }),
  summary: NodeSummarySchema,
  host: z.record(z.unknown()).nullable(),
  services: z.array(NodeServiceHealthSchema),
  links: z.array(NodePeerLinkSchema),
  node_info: NodeInfoSchema,
  /** この拠点が受けた依頼の直近分 (新しい順)。 */
  operations: z.array(OperationSummarySchema),
});
export type NodeHealthPayload = z.infer<typeof NodeHealthPayloadSchema>;
