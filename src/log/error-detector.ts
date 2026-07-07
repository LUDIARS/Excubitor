/**
 * error_rules チE�Eブルを読み込んで log line と照合する、E
 *
 * - regex (pattern_type='regex') / keyword (pattern_type='keyword')
 * - service_codes が指定されてれ�E対象を絞る
 * - 同一 (rule_id, service_instance_id, summary) めE60 秒以冁E��めEoccurrence_count++ で dedup
 * - 新要E/ 復活時�E error_tasks に行を作る (state='open')
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createNamedLogger } from '../shared/logger.js';
import { db } from '../db/client.js';
import { subscribe, type LogLine } from './bus.js';
import type { Service } from '../catalog/loader.js';
import { maybeDispatchCrashFixToConcordia } from '../auto_fix/concordia-dispatch.js';
// 自勁Etrigger は v0.2 で廁E��、Eerror_task は記録するだけ、E「調査、E「修正、Eは
// ユーザぁEUI 上�Eボタンから手動で叩く、EmaybeTriggerAutoFix は封E��戻す可能性
// がある�Eで関数自体�E残してある (現在は呼ばれなぁE、E
// import { maybeTriggerAutoFix } from '../auto_fix/trigger.js';

const logger = createNamedLogger('excubitor.errors');

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

// catalog 参�Eを遅延で受け取る (cycle 回避)
let catalogProvider: (() => { services: Service[] }) | null = null;
export function setCatalogProvider(fn: () => { services: Service[] }): void {
  catalogProvider = fn;
}

async function reloadRules(): Promise<void> {
  const rows = db().all(sql`
    SELECT id, name, pattern, pattern_type, severity, service_codes
    FROM error_rules
    WHERE is_active = 1
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
      // service_codes は SQLite では JSON 斁E���Eで持ってぁE�� (允ETEXT[])、E
      // raw SQL 経由で取得してぁE��ので自前で JSON.parse する、E
      const rawCodes = raw.service_codes;
      let serviceCodes: string[] | null = null;
      if (rawCodes != null) {
        if (typeof rawCodes === 'string') {
          try { serviceCodes = JSON.parse(rawCodes) as string[]; } catch { serviceCodes = null; }
        } else if (Array.isArray(rawCodes)) {
          serviceCodes = rawCodes as string[];
        }
      }
      list.push({
        id: raw.id as string,
        name: raw.name as string,
        pattern,
        pattern_type: type as 'regex' | 'keyword',
        severity: raw.severity as string,
        service_codes: serviceCodes,
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
  // SQLite では PG の data-modifying CTE (WITH ... UPDATE ... FROM si) めE
  // 直接書けなぁE�Eで、E同一トランザクションで以下�E手頁E��刁E��する:
  //   1) service_instance_id めEresolve
  //   2) 60 秒以冁E�E吁Erule ÁEinstance ÁEopen 系 task めEUPDATE ... RETURNING
  //   3) ヒッチE0 件なめEINSERT
  const siRow = db().get(sql`
    SELECT si.id AS id
    FROM service_instances si
    JOIN services s ON s.id = si.service_id
    WHERE s.code = ${line.service_code}
    LIMIT 1
  `) as { id: string } | undefined;
  if (!siRow) return;
  const sixtySecondsAgo = Date.now() - 60_000;
  const existing = db().all(sql`
    UPDATE error_tasks
    SET occurrence_count = occurrence_count + 1,
        last_seen_at = unixepoch() * 1000,
        updated_at = unixepoch() * 1000
    WHERE rule_id = ${rule.id}
      AND service_instance_id = ${siRow.id}
      AND state IN ('open','ack','snoozed')
      AND last_seen_at > ${sixtySecondsAgo}
    RETURNING id
  `) as Array<{ id: string }>;
  if (existing.length === 0) {
    const newId = randomUUID();
    // first_seen_at / last_seen_at は NOT NULL かつ SQL default 無し → 明示指定しないと
    // INSERT が NOT NULL 制約で失敗する (この catch 経由で握り潰され task が作られない)。
    db().run(sql`
      INSERT INTO error_tasks (id, rule_id, service_instance_id, severity, summary, log_excerpt, first_seen_at, last_seen_at)
      VALUES (${newId}, ${rule.id}, ${siRow.id}, ${rule.severity}, ${summary}, ${line.line}, unixepoch() * 1000, unixepoch() * 1000)
    `);
    const service = catalogProvider?.().services.find((s) => s.code === line.service_code);
    if (service) {
      void maybeDispatchCrashFixToConcordia({
        errorTaskId: newId,
        service,
        severity: rule.severity,
        summary,
        logExcerpt: line.line,
        source: 'log',
      }).catch((err: unknown) =>
        logger.warn({ err: (err as Error).message, errorTaskId: newId }, 'Concordia dispatch failed'),
      );
    }
  }
  // error_task は記録するだけ、E「調査、E「修正、EはユーザぁEUI から手動で
  // 起動すめE(= POST /api/v1/error-tasks/:id/investigate or /auto-fix)、E
}

export async function startErrorDetector(): Promise<void> {
  await reloadRules();
  subscribe((l) => void onLine(l));
  logger.info('error detector subscribed');
}


