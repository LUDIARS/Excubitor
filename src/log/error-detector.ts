/**
 * error_rules テーブルを読み込んで log line と照合する。
 *
 * - regex (pattern_type='regex') / keyword (pattern_type='keyword')
 * - service_codes が指定されてれば対象を絞る
 * - 同一 (rule_id, service_instance_id, summary) を 60 秒以内なら occurrence_count++ で dedup
 * - 新規 / 復活時は error_tasks に行を作る (state='open')
 */
import { sql } from 'drizzle-orm';
import pino from 'pino';
import { db } from '../db/client.js';
import { subscribe, type LogLine } from './bus.js';
import type { Service } from '../catalog/loader.js';
// 自動 trigger は v0.2 で廃止。 error_task は記録するだけ、 「調査」 「修正」 は
// ユーザが UI 上のボタンから手動で叩く。 maybeTriggerAutoFix は将来戻す可能性
// があるので関数自体は残してある (現在は呼ばれない)。
// import { maybeTriggerAutoFix } from '../auto_fix/trigger.js';

const logger = pino({ name: 'excubitor.errors' });

interface Rule {
  id: string;
  name: string;
  pattern: string;
  pattern_type: 'regex' | 'keyword';
  severity: string;
  service_codes: string[] | null;
  compiled: RegExp;
}

let rules: Rule[] = [];
let lastReload = 0;
const RELOAD_INTERVAL_MS = 30_000;

// catalog 参照を遅延で受け取る (cycle 回避)
let catalogProvider: (() => { services: Service[] }) | null = null;
export function setCatalogProvider(fn: () => { services: Service[] }): void {
  catalogProvider = fn;
}

async function reloadRules(): Promise<void> {
  const rows = await db.execute(sql`
    SELECT id, name, pattern, pattern_type, severity, service_codes
    FROM error_rules
    WHERE is_active = TRUE
  `);
  const list: Rule[] = [];
  for (const raw of rows as unknown as Array<Record<string, unknown>>) {
    try {
      const pattern = raw.pattern as string;
      const type = (raw.pattern_type as string) === 'keyword' ? 'keyword' : 'regex';
      const compiled =
        type === 'keyword'
          ? new RegExp(escapeRegex(pattern), 'i')
          : new RegExp(pattern, 'i');
      list.push({
        id: raw.id as string,
        name: raw.name as string,
        pattern,
        pattern_type: type as 'regex' | 'keyword',
        severity: raw.severity as string,
        service_codes: (raw.service_codes as string[] | null) ?? null,
        compiled,
      });
    } catch (err) {
      logger.warn({ id: raw.id, err: (err as Error).message }, 'invalid rule pattern, skipped');
    }
  }
  rules = list;
  lastReload = Date.now();
  logger.info({ count: rules.length }, 'rules loaded');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function shouldReload(): boolean {
  return Date.now() - lastReload > RELOAD_INTERVAL_MS;
}

async function onLine(line: LogLine): Promise<void> {
  if (shouldReload()) {
    await reloadRules().catch((err: unknown) =>
      logger.warn({ err: (err as Error).message }, 'rule reload failed'),
    );
  }
  for (const rule of rules) {
    if (rule.service_codes && !rule.service_codes.includes(line.service_code)) continue;
    if (!rule.compiled.test(line.line)) continue;
    void recordHit(rule, line).catch((err: unknown) =>
      logger.warn({ err: (err as Error).message }, 'recordHit failed'),
    );
  }
}

async function recordHit(rule: Rule, line: LogLine): Promise<void> {
  const summary = `[${rule.name}] ${line.line.slice(0, 160)}`;
  // 新規 INSERT 時の id を取得して auto-fix trigger 用にも返す
  const rows = await db.execute(sql`
    WITH si AS (
      SELECT si.id
      FROM service_instances si
      JOIN services s ON s.id = si.service_id
      WHERE s.code = ${line.service_code}
      LIMIT 1
    ),
    existing AS (
      UPDATE error_tasks et
      SET occurrence_count = et.occurrence_count + 1,
          last_seen_at = now(),
          updated_at = now()
      FROM si
      WHERE et.rule_id = ${rule.id}
        AND et.service_instance_id = si.id
        AND et.state IN ('open','ack','snoozed')
        AND et.last_seen_at > now() - INTERVAL '60 seconds'
      RETURNING et.id, FALSE AS is_new
    ),
    inserted AS (
      INSERT INTO error_tasks (rule_id, service_instance_id, severity, summary, log_excerpt)
      SELECT ${rule.id}, si.id, ${rule.severity}, ${summary}, ${line.line}
      FROM si
      WHERE NOT EXISTS (SELECT 1 FROM existing)
      RETURNING id, TRUE AS is_new
    )
    SELECT id, is_new FROM inserted
    UNION ALL
    SELECT id, is_new FROM existing
    LIMIT 1
  `);
  // error_task は記録するだけ。 「調査」 「修正」 はユーザが UI から手動で
  // 起動する (= POST /api/v1/error-tasks/:id/investigate or /auto-fix)。
  const arr = rows as unknown as Array<{ id: string; is_new: boolean }>;
  void arr;
}

export async function startErrorDetector(): Promise<void> {
  await reloadRules();
  subscribe((l) => void onLine(l));
  logger.info('error detector subscribed');
}
