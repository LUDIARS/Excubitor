import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  failedResponse,
  ExcubitorStatusPayloadSchema,
  LocalControlActionSchema,
  LocalControlDispatchModeSchema,
  LocalControlResponseSchema,
  type ExcubitorStatusPayload,
  type LocalControlAction,
  type LocalControlResponse,
} from './protocol.js';

const OperationRecordSchema = z.object({
  operation_id: z.string(),
  target_key: z.string(),
  action: LocalControlActionSchema,
  actor: z.string().default('unknown'),
  dispatch: LocalControlDispatchModeSchema.default('execute'),
  accepted_at: z.string(),
  completed_at: z.string().optional(),
  response: LocalControlResponseSchema,
}).strict();

const PersistedStateSchema = z.object({
  version: z.literal(1),
  supervisor: z.object({
    pid: z.number().int().positive(),
    started_at: z.string(),
  }).strict(),
  excubitor: ExcubitorStatusPayloadSchema.optional(),
  operations: z.array(OperationRecordSchema),
}).strict();

export type PersistedState = z.infer<typeof PersistedStateSchema>;
export type OperationRecord = z.infer<typeof OperationRecordSchema>;

export interface SupervisorIdentity {
  pid: number;
  startedAt: string;
}

export interface StateStoreOptions {
  maxOperations?: number;
  persistState?: (state: Readonly<PersistedState>) => Promise<void>;
}

export class LocalControlStateStore {
  private state: PersistedState | null = null;
  private writeTail: Promise<void> = Promise.resolve();
  private readonly maxOperations: number;
  private readonly persistStateOverride?: (state: Readonly<PersistedState>) => Promise<void>;

  constructor(
    private readonly path: string,
    options: StateStoreOptions = {},
  ) {
    this.maxOperations = options.maxOperations ?? 100;
    this.persistStateOverride = options.persistState;
  }

  async initialize(identity: SupervisorIdentity): Promise<void> {
    const existing = await this.readExisting();
    const operations = (existing?.operations ?? []).map((record) => {
      if (record.response.state !== 'accepted') return record;
      return {
        ...record,
        completed_at: identity.startedAt,
        response: failedResponse(
          record.operation_id,
          'INTERRUPTED',
          'supervisor restarted before the deferred operation completed',
        ),
      } satisfies OperationRecord;
    });
    this.state = {
      version: 1,
      supervisor: { pid: identity.pid, started_at: identity.startedAt },
      ...(existing?.excubitor ? { excubitor: existing.excubitor } : {}),
      operations: operations.slice(-this.maxOperations),
    };
    await this.persist();
  }

  getOperation(operationId: string): OperationRecord | undefined {
    return this.requireState().operations.find((record) => record.operation_id === operationId);
  }

  async recordAccepted(
    operationId: string,
    targetKey: string,
    action: LocalControlAction,
    acceptedAt: string,
    response: LocalControlResponse,
    actor = 'unknown',
    dispatch: OperationRecord['dispatch'] = 'execute',
  ): Promise<void> {
    await this.update((state) => {
      const existingIndex = state.operations.findIndex((record) => record.operation_id === operationId);
      const record: OperationRecord = {
        operation_id: operationId,
        target_key: targetKey,
        action,
        actor,
        dispatch,
        accepted_at: acceptedAt,
        response,
      };
      if (existingIndex >= 0) state.operations[existingIndex] = record;
      else state.operations.push(record);
      state.operations = state.operations.slice(-this.maxOperations);
    });
  }

  async recordCompleted(operationId: string, completedAt: string, response: LocalControlResponse): Promise<void> {
    await this.update((state) => {
      const record = state.operations.find((candidate) => candidate.operation_id === operationId);
      if (!record) throw new Error(`operation ${operationId} was not accepted`);
      record.completed_at = completedAt;
      record.response = response;
    }, true);
  }

  async recordExcubitor(status: ExcubitorStatusPayload): Promise<void> {
    await this.update((state) => {
      state.excubitor = status;
    }, true);
  }

  excubitorStatus(): ExcubitorStatusPayload | undefined {
    return this.requireState().excubitor;
  }

  private async readExisting(): Promise<PersistedState | null> {
    try {
      const raw = await readFile(this.path, 'utf8');
      return PersistedStateSchema.parse(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async update(mutator: (state: PersistedState) => void, commitOnPersistFailure = false): Promise<void> {
    const write = this.writeTail.then(async () => {
      const next = structuredClone(this.requireState());
      mutator(next);
      try {
        await this.persistNow(next);
      } catch (error) {
        // Completion follows an external side effect and must remain visible in
        // memory even if its durable write failed. Acceptance has no side effect
        // yet, so its failed write is rolled back and can be retried safely.
        if (commitOnPersistFailure) this.state = next;
        throw error;
      }
      this.state = next;
    });
    this.writeTail = write.catch(() => undefined);
    return write;
  }

  private async persist(): Promise<void> {
    const write = this.writeTail.then(() => this.persistNow(this.requireState()));
    this.writeTail = write.catch(() => undefined);
    return write;
  }

  private async persistNow(state: PersistedState): Promise<void> {
    if (this.persistStateOverride) {
      await this.persistStateOverride(state);
      return;
    }
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${process.pid}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await rename(temporaryPath, this.path);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private requireState(): PersistedState {
    if (!this.state) throw new Error('local-control state store is not initialized');
    return this.state;
  }
}
