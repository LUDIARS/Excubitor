/**
 * `ergo_pkg watch` が書く `events.json` / `watch-report.json` (schema 1) の読み取り形。
 *
 * 正本は Ergo の spec/data/ergo-watch-report.md。 配送に使うキーだけを検査し、 未知のキーは捨てる。
 *
 * @implements SPEC-ERGO-WATCH-DELIVERY
 */

import { z } from 'zod';

export const ERGO_WATCH_KINDS = ['tag', 'track', 'off-main', 'run', 'review', 'merged'] as const;
export const ERGO_WATCH_ORIGINS = ['pf', 'ai', 'human', 'unknown'] as const;

const SourceStateSchema = z.enum(['ok', 'unavailable', 'off']);

export const WatchSourcesSchema = z.object({
  concordia: SourceStateSchema.catch('off'),
  revisor: SourceStateSchema.catch('off'),
});

const CandidateShape = {
  dependency: z.string(),
  kind: z.enum(ERGO_WATCH_KINDS),
  subject: z.string().default(''),
  from_rev: z.string().default(''),
  from_tag: z.string().default(''),
  to_rev: z.string().default(''),
  to_tag: z.string().default(''),
  behind: z.number().int().nullable().default(null),
  warning: z.boolean().default(false),
  strict_ok: z.boolean().default(false),
  next: z.string().default(''),
  origin: z.enum(ERGO_WATCH_ORIGINS).optional(),
  trigger: z.string().default(''),
  review: z.number().int().nullable().default(null),
  head: z.string().default(''),
};

export const WatchEventSchema = z.object({
  ...CandidateShape,
  id: z.string(),
  host: z.string(),
  code: z.string().default(''),
  owner: z.string().default(''),
  private: z.boolean().default(false),
  as_of: z.string().default(''),
  at: z.string().default(''),
  since_notified: z.number().int().nullable().default(null),
});

export const EventsFileSchema = z.object({
  schema: z.literal(1),
  generated_at: z.string(),
  hosts: z.array(z.string()).default([]),
  events: z.array(WatchEventSchema),
  sources: WatchSourcesSchema.default({ concordia: 'off', revisor: 'off' }),
});

export const PendingEntrySchema = z.object({
  ...CandidateShape,
  id: z.string().default(''),
  first_seen: z.string().default(''),
});

export const WatchReportSchema = z.object({
  schema: z.literal(1),
  host: z.string(),
  generated_at: z.string(),
  pending: z.array(PendingEntrySchema).default([]),
  sources: WatchSourcesSchema.default({ concordia: 'off', revisor: 'off' }),
});

export type WatchEvent = z.infer<typeof WatchEventSchema>;
export type EventsFile = z.infer<typeof EventsFileSchema>;
export type PendingEntry = z.infer<typeof PendingEntrySchema>;
export type WatchReport = z.infer<typeof WatchReportSchema>;
export type WatchSources = z.infer<typeof WatchSourcesSchema>;

/** 監視対象の checkout 1 つ (catalog の `ergo_watch` から)。 */
export interface WatchHost {
  /** checkout の root (絶対パス)。 引数にだけ使い、 本文・ログへ出さない。 */
  dir: string;
  /** そのホストを宣言した catalog のサービス code (表示・診断用)。 */
  serviceCodes: string[];
  private: boolean;
}

/** 配送先の区分。 private は非公開ホスト・非公開依存の出来事。 */
export type DeliveryChannel = 'public' | 'private';

export interface DeliveryMessage {
  channel: DeliveryChannel;
  content: string;
}
