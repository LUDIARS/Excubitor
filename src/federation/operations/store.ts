/**
 * 依頼 (federation_operations) の永続化。 状態遷移はここを通す:
 *   queued → running → succeeded / failed
 *   running → restarting (Excubitor 自身の再起動を依頼した) → 再起動後に succeeded / failed
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  OperationActionSchema,
  OperationStatusSchema,
  UpdateSourceSchema,
  type OperationAction,
  type OperationDetail,
  type OperationStatus,
  type OperationStep,
  type OperationSummary,
  type OperationTarget,
  type UpdateSource,
} from './types.js';

/** @implements SPEC-FEDERATION-OPERATIONS */

export interface OperationRecord extends OperationDetail {
  requester_peer_id: string | null;
  meta: Record<string, unknown>;
}

export interface NewOperation {
  requestedBy: string;
  requesterPeerId: string | null;
  target: OperationTarget;
  action: OperationAction;
  source: UpdateSource;
  now: number;
}

interface OperationRow {
  id: string;
  requested_by: string;
  requester_peer_id: string | null;
  target_kind: string;
  target_code: string | null;
  action: string;
  source: string;
  status: string;
  steps: string;
  error: string | null;
  meta: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // 手で壊された行でも一覧は出せるようにする (中身は空として扱う)。
    return fallback;
  }
}

function toRecord(row: OperationRow): OperationRecord {
  const steps = parseJson<OperationStep[]>(row.steps, []);
  const target: OperationTarget = row.target_kind === 'excubitor'
    ? { kind: 'excubitor' }
    : { kind: 'service', code: row.target_code ?? '' };
  return {
    id: row.id,
    requested_by: row.requested_by,
    requester_peer_id: row.requester_peer_id,
    target,
    action: OperationActionSchema.parse(row.action),
    status: OperationStatusSchema.parse(row.status),
    source: UpdateSourceSchema.parse(row.source),
    error: row.error,
    last_step: steps.at(-1)?.step ?? null,
    steps,
    meta: parseJson<Record<string, unknown>>(row.meta, {}),
    created_at: Number(row.created_at),
    started_at: row.started_at == null ? null : Number(row.started_at),
    finished_at: row.finished_at == null ? null : Number(row.finished_at),
  };
}

export function toSummary(record: OperationRecord): OperationSummary {
  return {
    id: record.id,
    requested_by: record.requested_by,
    target: record.target,
    action: record.action,
    status: record.status,
    source: record.source,
    error: record.error,
    last_step: record.last_step,
    created_at: record.created_at,
    started_at: record.started_at,
    finished_at: record.finished_at,
  };
}

export function toDetail(record: OperationRecord): OperationDetail {
  return { ...toSummary(record), steps: record.steps };
}

export function createOperation(input: NewOperation): OperationRecord {
  const id = randomUUID();
  const code = input.target.kind === 'service' ? input.target.code : null;
  db().run(sql`
    INSERT INTO federation_operations (
      id, requested_by, requester_peer_id, target_kind, target_code, action, source, status, steps, created_at
    ) VALUES (
      ${id}, ${input.requestedBy}, ${input.requesterPeerId}, ${input.target.kind}, ${code},
      ${input.action}, ${input.source}, ${'queued'}, ${'[]'}, ${input.now}
    )
  `);
  return getOperation(id)!;
}

export function getOperation(id: string): OperationRecord | null {
  const row = db().get(sql`SELECT * FROM federation_operations WHERE id = ${id} LIMIT 1`) as OperationRow | undefined;
  return row ? toRecord(row) : null;
}

/** 新しい順。 */
export function listRecentOperations(limit: number): OperationRecord[] {
  const rows = db().all(sql`
    SELECT * FROM federation_operations ORDER BY created_at DESC, rowid DESC LIMIT ${limit}
  `) as OperationRow[];
  return rows.map(toRecord);
}

export function listByStatus(status: OperationStatus): OperationRecord[] {
  const rows = db().all(sql`
    SELECT * FROM federation_operations WHERE status = ${status} ORDER BY created_at ASC, rowid ASC
  `) as OperationRow[];
  return rows.map(toRecord);
}

export function markRunning(id: string, now: number): void {
  db().run(sql`UPDATE federation_operations SET status = 'running', started_at = ${now} WHERE id = ${id}`);
}

export function appendStep(id: string, step: OperationStep): void {
  const current = getOperation(id);
  if (!current) return;
  const steps = [...current.steps, step];
  db().run(sql`UPDATE federation_operations SET steps = ${JSON.stringify(steps)} WHERE id = ${id}`);
}

export function markRestarting(id: string, meta: Record<string, unknown>): void {
  db().run(sql`
    UPDATE federation_operations SET status = 'restarting', meta = ${JSON.stringify(meta)} WHERE id = ${id}
  `);
}

export function finishOperation(id: string, ok: boolean, error: string | null, now: number): void {
  db().run(sql`
    UPDATE federation_operations
    SET status = ${ok ? 'succeeded' : 'failed'}, error = ${ok ? null : error}, finished_at = ${now}
    WHERE id = ${id}
  `);
}
