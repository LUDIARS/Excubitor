import { join } from 'node:path';
import { closeDb, openDb } from '../db/index.js';
import { controlService } from '../control/manager.js';
import {
  getManagedPid,
  markServiceStopped,
  resumeProcessRestarts,
  suspendProcessRestarts,
  validateManagedProcess,
} from '../process/manager.js';
import { runEmergencyAction } from '../ops/emergency.js';
import { createNamedLogger } from '../shared/logger.js';
import { AdoptedProcessReaper } from './adopted-process-reaper.js';
import { SupervisorCatalogRuntime } from './catalog-runtime.js';
import { localControlEndpoint } from './endpoint.js';
import { ExcubitorBackendController } from './excubitor-backend.js';
import {
  boundEmergencyResult,
  boundControlResult,
  failedResponse,
  LOCAL_CONTROL_PROTOCOL_VERSION,
  targetKey,
  type LocalControlRequest,
  type LocalControlCompletedPayload,
  type LocalControlResponse,
  type ServiceStatusPayload,
} from './protocol.js';
import { LocalControlServer, type LocalControlDispatch } from './server.js';
import { LocalControlStateStore } from './state-store.js';
import { TargetOperationQueue } from './target-queue.js';

const logger = createNamedLogger('excubitor.local-control');
const DEFAULT_OPERATION_DRAIN_TIMEOUT_MS = 30_000;

export interface LocalControlSupervisorOptions {
  rootDir?: string;
  endpoint?: string;
  databasePath?: string;
  statePath?: string;
  catalogPath?: string;
  now?: () => string;
  backend?: ExcubitorBackendController;
  adoptedReapIntervalMs?: number;
  operationDrainTimeoutMs?: number;
}

interface InflightDispatch {
  targetKey: string;
  action: LocalControlRequest['action'];
  dispatch: LocalControlRequest['dispatch'];
  promise: Promise<LocalControlDispatch>;
}

export class LocalControlSupervisor {
  private readonly rootDir: string;
  private readonly now: () => string;
  private readonly stateStore: LocalControlStateStore;
  private readonly catalog: SupervisorCatalogRuntime;
  private readonly backend: ExcubitorBackendController;
  private readonly server: LocalControlServer;
  private readonly operations = new TargetOperationQueue();
  private readonly operationDrainTimeoutMs: number;
  private readonly adoptedProcessReaper: AdoptedProcessReaper;
  private readonly inflight = new Map<string, InflightDispatch>();
  private readonly committedDeferredOperations = new Set<string>();
  private readonly ready: Promise<void>;
  private resolveReady: () => void = () => undefined;
  private readonly catalogReady: Promise<void>;
  private resolveCatalogReady: () => void = () => undefined;
  private startupError: Error | null = null;
  private started = false;
  private closeRequestVersion = 0;
  private closing = false;
  private lifecycleTail: Promise<void> = Promise.resolve();

  constructor(options: LocalControlSupervisorOptions = {}) {
    this.rootDir = options.rootDir ?? process.cwd();
    this.now = options.now ?? (() => new Date().toISOString());
    this.operationDrainTimeoutMs = options.operationDrainTimeoutMs ?? DEFAULT_OPERATION_DRAIN_TIMEOUT_MS;
    this.stateStore = new LocalControlStateStore(
      options.statePath ?? join(this.rootDir, 'data', 'local-control-state.json'),
    );
    this.catalog = new SupervisorCatalogRuntime(this.rootDir, options.catalogPath);
    this.adoptedProcessReaper = new AdoptedProcessReaper({
      queue: this.operations,
      refreshCatalog: () => this.catalog.refresh(),
      service: (code) => this.catalog.service(code),
      intervalMs: options.adoptedReapIntervalMs,
      onError: (error, code) => logger.error(
        { code, err: error.message },
        'adopted process recovery failed',
      ),
    });
    this.backend = options.backend ?? new ExcubitorBackendController({
      rootDir: this.rootDir,
      // Returning the write lets the controller wait for durable pid/token
      // publication before it begins backend readiness checks.
      onStatus: (status) => this.stateStore.recordExcubitor(status),
      onError: (error) => logger.error({ err: error.message }, 'Excubitor backend lifecycle error'),
    });
    this.server = new LocalControlServer({
      endpoint: options.endpoint ?? localControlEndpoint(),
      handler: (request) => this.dispatch(request),
      onError: (error) => logger.error({ err: error.message }, 'local-control IPC error'),
    });
    this.databasePath = options.databasePath ?? join(this.rootDir, 'data', 'excubitor.sqlite');
    this.ready = new Promise<void>((resolve) => { this.resolveReady = resolve; });
    this.catalogReady = new Promise<void>((resolve) => { this.resolveCatalogReady = resolve; });
  }

  private readonly databasePath: string;

  start(): Promise<void> {
    const closeRequestVersion = this.closeRequestVersion;
    return this.serializeLifecycle(() => this.startInternal(closeRequestVersion));
  }

  close(): Promise<void> {
    this.closeRequestVersion += 1;
    this.closing = true;
    return this.serializeLifecycle(() => this.closeInternal());
  }

  private async startInternal(closeRequestVersion: number): Promise<void> {
    if (this.started) return;
    const shouldStop = (): boolean => this.closeRequestVersion !== closeRequestVersion;
    if (shouldStop()) return;
    this.closing = false;
    try {
      // The IPC endpoint is the single-writer lock. Acquire it before catalog
      // reconciliation/autostart so concurrent CLI bootstraps cannot both
      // launch services and only discover EADDRINUSE afterwards.
      await this.server.listen();
      this.started = true;
      if (shouldStop()) return;
      resumeProcessRestarts();
      openDb(this.databasePath);
      await this.stateStore.initialize({ pid: process.pid, startedAt: this.now() });
      if (shouldStop()) return;
      // Reserve backend recovery as one lifecycle operation before exposing IPC
      // readiness. Any CLI start/restart arriving now queues behind recovery
      // instead of racing adoption and losing the ChildProcess handle.
      const backendRecovery = this.backend.recover(this.stateStore.excubitorStatus());
      this.resolveReady();
      try {
        await backendRecovery;
      } catch (error) {
        logger.error({ err: asError(error).message }, 'initial Excubitor backend start failed; supervisor remains available');
      }
      await this.stateStore.recordExcubitor(this.backend.status()).catch((error: unknown) => {
        logger.error({ err: asError(error).message }, 'failed to persist recovered Excubitor backend status');
      });
      if (shouldStop()) return;
      try {
        await this.catalog.initialize({ shouldStop });
      } catch (error) {
        // Keep the supervisor available for Excubitor recovery. Service
        // commands retry catalog refresh and surface the configuration error.
        logger.error({ err: asError(error).message }, 'initial catalog lifecycle reconciliation failed');
      } finally {
        this.resolveCatalogReady();
      }
      if (shouldStop()) return;
      this.adoptedProcessReaper.start();
    } catch (error) {
      this.startupError = asError(error);
      suspendProcessRestarts();
      await this.server.close().catch(() => undefined);
      this.started = false;
      closeDb();
      throw error;
    } finally {
      this.resolveReady();
      this.resolveCatalogReady();
    }
  }

  private async closeInternal(): Promise<void> {
    if (!this.started) return;
    const errors: unknown[] = [];
    suspendProcessRestarts();
    await collectCleanupError(errors, () => this.adoptedProcessReaper.close());
    try {
      // Keep the IPC endpoint and DB ownership until every accepted side effect
      // has actually finished. If drain times out, leave both held so the OS
      // manager's hard-kill/restart cannot overlap a second supervisor with the
      // still-running old operation.
      await withTimeout(
        this.drainOperations(),
        this.operationDrainTimeoutMs,
        `local-control operations did not drain within ${this.operationDrainTimeoutMs}ms`,
      );
    } catch (error) {
      errors.push(error);
      throw new AggregateError(errors, 'local-control supervisor cleanup failed before ownership release');
    }
    try {
      await this.server.close();
    } catch (error) {
      errors.push(error);
      throw new AggregateError(errors, 'local-control supervisor cleanup failed before ownership release');
    }
    this.started = false;
    await collectCleanupError(errors, () => this.backend.preserveForSupervisorShutdown());
    await collectCleanupError(errors, () => this.stateStore.recordExcubitor(this.backend.status()));
    try {
      closeDb();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) throw new AggregateError(errors, 'local-control supervisor cleanup failed');
  }

  private serializeLifecycle(operation: () => Promise<void>): Promise<void> {
    const result = this.lifecycleTail.then(operation, operation);
    this.lifecycleTail = result.catch(() => undefined);
    return result;
  }

  private async drainOperations(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.all(Array.from(this.inflight.values(), (entry) => entry.promise.catch(() => undefined)));
    }
    await this.operations.drain();
  }

  private async dispatch(request: LocalControlRequest): Promise<LocalControlDispatch> {
    await this.ready;
    if (this.startupError) {
      return {
        response: failedResponse(request.operation_id, 'SUPERVISOR_START_FAILED', this.startupError.message),
      };
    }
    if (this.closing) {
      return {
        response: failedResponse(request.operation_id, 'SUPERVISOR_CLOSING', 'local-control supervisor is closing'),
      };
    }
    if (request.target.kind === 'service') {
      await this.catalogReady;
      if (this.closing) {
        return {
          response: failedResponse(request.operation_id, 'SUPERVISOR_CLOSING', 'local-control supervisor is closing'),
        };
      }
    }
    const key = targetKey(request.target);
    if (request.dispatch === 'commit') return this.commitDeferred(request, key);
    if (request.dispatch === 'prepare' && !isDeferredExcubitorOperation(request)) {
      return {
        response: failedResponse(
          request.operation_id,
          'PREPARE_NOT_SUPPORTED',
          'prepare is supported only for Excubitor stop/restart',
        ),
      };
    }
    if (request.action === 'status') {
      const readStatus = async (): Promise<LocalControlResponse> => {
        try {
          return request.target.kind === 'service'
            ? await this.executeService(request)
            : await this.executeExcubitor(request);
        } catch (error) {
          return failedResponse(request.operation_id, 'OPERATION_FAILED', asError(error).message);
        }
      };
      // Excubitor status is an in-memory transitional snapshot and must remain
      // available while start/restart readiness is occupying the lifecycle queue.
      const response = request.target.kind === 'excubitor'
        ? await readStatus()
        : await this.operations.run(key, readStatus);
      return { response };
    }
    const persisted = this.stateStore.getOperation(request.operation_id);
    if (persisted) {
      if (
        persisted.target_key !== key
        || persisted.action !== request.action
        || persisted.dispatch !== request.dispatch
      ) {
        return {
          response: failedResponse(
            request.operation_id,
            'OPERATION_ID_CONFLICT',
            'operation id was already used for a different target or action',
          ),
        };
      }
      return { response: persisted.response };
    }

    const pending = this.inflight.get(request.operation_id);
    if (pending) {
      if (
        pending.targetKey !== key
        || pending.action !== request.action
        || pending.dispatch !== request.dispatch
      ) {
        return {
          response: failedResponse(
            request.operation_id,
            'OPERATION_ID_CONFLICT',
            'operation id is in use by a different target or action',
          ),
        };
      }
      return pending.promise;
    }

    const promise = this.beginDispatch(request, key);
    this.inflight.set(request.operation_id, {
      targetKey: key,
      action: request.action,
      dispatch: request.dispatch,
      promise,
    });
    void promise.then(
      () => this.inflight.delete(request.operation_id),
      () => this.inflight.delete(request.operation_id),
    );
    return promise;
  }

  private async beginDispatch(request: LocalControlRequest, key: string): Promise<LocalControlDispatch> {
    const accepted = acceptedResponse(request, key);
    await this.stateStore.recordAccepted(
      request.operation_id,
      key,
      request.action,
      this.now(),
      accepted,
      request.actor,
      request.dispatch,
    );

    if (isDeferredExcubitorOperation(request)) {
      if (request.dispatch === 'prepare') return { response: accepted };
    }

    return {
      response: await this.operations.run(key, () => this.executeRecorded(request)),
    };
  }

  private commitDeferred(request: LocalControlRequest, key: string): LocalControlDispatch {
    if (!isDeferredExcubitorOperation(request)) {
      return {
        response: failedResponse(
          request.operation_id,
          'COMMIT_NOT_SUPPORTED',
          'commit is supported only for Excubitor stop/restart',
        ),
      };
    }
    const persisted = this.stateStore.getOperation(request.operation_id);
    if (!persisted) {
      return {
        response: failedResponse(request.operation_id, 'OPERATION_NOT_PREPARED', 'operation was not prepared'),
      };
    }
    if (persisted.target_key !== key || persisted.action !== request.action) {
      return {
        response: failedResponse(
          request.operation_id,
          'OPERATION_ID_CONFLICT',
          'prepared operation target/action does not match commit',
        ),
      };
    }
    if (persisted.dispatch !== 'prepare') {
      return {
        response: failedResponse(request.operation_id, 'OPERATION_NOT_PREPARED', 'operation was not prepared'),
      };
    }
    if (persisted.response.state !== 'accepted') return { response: persisted.response };
    return this.deferredExecutionDispatch(request, key, persisted.response);
  }

  private deferredExecutionDispatch(
    request: LocalControlRequest,
    key: string,
    response: LocalControlResponse,
  ): LocalControlDispatch {
    return {
      response,
      afterReply: async () => {
        // The same dispatch promise can be observed by multiple sockets when a
        // client retries an operation_id concurrently. Claim execution before
        // the first await so every reply callback after the first is a no-op.
        if (this.closing) return;
        if (this.committedDeferredOperations.has(request.operation_id)) return;
        this.committedDeferredOperations.add(request.operation_id);
        try {
          const current = this.stateStore.getOperation(request.operation_id);
          if (!current || current.response.state !== 'accepted') return;
          await this.operations.run(key, async () => {
            if (this.closing) return;
            await this.executeRecorded(request);
          });
        } finally {
          this.committedDeferredOperations.delete(request.operation_id);
        }
      },
    };
  }

  private async executeRecorded(request: LocalControlRequest): Promise<LocalControlResponse> {
    let response: LocalControlResponse;
    try {
      response = request.target.kind === 'service'
        ? await this.executeService(request)
        : await this.executeExcubitor(request);
    } catch (error) {
      response = failedResponse(request.operation_id, 'OPERATION_FAILED', asError(error).message);
    }
    await this.stateStore.recordCompleted(request.operation_id, this.now(), response).catch((error: unknown) => {
      logger.error(
        { operation_id: request.operation_id, err: asError(error).message },
        'failed to persist completed local-control operation',
      );
    });
    return response;
  }

  private async executeService(request: LocalControlRequest): Promise<LocalControlResponse> {
    if (request.target.kind !== 'service') throw new Error('service request expected');
    const catalog = await this.catalog.refresh();
    const service = this.catalog.service(request.target.code);
    if (!service) {
      return failedResponse(request.operation_id, 'SERVICE_NOT_FOUND', `service ${request.target.code} is not in the catalog`);
    }

    if (request.action === 'status') {
      const status = await serviceStatus(service.code, service.runtime);
      return completedResponse(request.operation_id, status);
    }
    if (service.disabled && request.action !== 'stop') {
      return failedResponse(request.operation_id, 'SERVICE_DISABLED', `service ${service.code} is disabled`);
    }

    if (request.action === 'kill-port' || request.action === 'claude-port-fix') {
      // Emergency kill/fix is an explicit stop intent. Cancel automatic
      // process recovery before touching a listener so it cannot immediately
      // resurrect the process behind the operator's back.
      markServiceStopped(service.code);
      const result = boundEmergencyResult(await runEmergencyAction(
        catalog,
        service,
        request.action,
        request.parameters?.prompt,
        request.parameters?.port,
      ));
      const payload = { kind: 'emergency-result' as const, value: result };
      return result.ok
        ? completedResponse(request.operation_id, payload)
        : failedResponse(
            request.operation_id,
            'EMERGENCY_FAILED',
            result.stderr || `service ${service.code} ${request.action} failed`,
            payload,
          );
    }

    const result = boundControlResult(await controlService(service, request.action, request.actor));
    const payload = { kind: 'control-result' as const, value: result };
    return result.ok
      ? completedResponse(request.operation_id, payload)
      : failedResponse(
          request.operation_id,
          'CONTROL_FAILED',
          result.stderr || `service ${service.code} ${request.action} failed`,
          payload,
        );
  }

  private async executeExcubitor(request: LocalControlRequest): Promise<LocalControlResponse> {
    if (request.target.kind !== 'excubitor') throw new Error('Excubitor request expected');
    const status = request.action === 'start'
      ? await this.backend.start()
      : request.action === 'stop'
        ? await this.backend.stop()
        : request.action === 'restart'
          ? await this.backend.restart()
          : request.action === 'status'
            ? this.backend.status()
            : (() => { throw new Error(`action ${request.action} is invalid for Excubitor`); })();
    return completedResponse(request.operation_id, status);
  }
}

function acceptedResponse(request: LocalControlRequest, key: string): LocalControlResponse {
  return {
    protocol_version: LOCAL_CONTROL_PROTOCOL_VERSION,
    operation_id: request.operation_id,
    ok: true,
    state: 'accepted',
    payload: { kind: 'accepted', deferred: true, target_key: key },
  };
}

function isDeferredExcubitorOperation(request: LocalControlRequest): boolean {
  return request.target.kind === 'excubitor' && (request.action === 'restart' || request.action === 'stop');
}

function completedResponse(
  operationId: string,
  payload: LocalControlCompletedPayload,
): LocalControlResponse {
  return {
    protocol_version: LOCAL_CONTROL_PROTOCOL_VERSION,
    operation_id: operationId,
    ok: true,
    state: 'completed',
    payload,
  };
}

async function serviceStatus(code: string, runtime: string): Promise<ServiceStatusPayload> {
  if (runtime !== 'node' && runtime !== 'dev-process-md' && runtime !== 'app') {
    return { kind: 'service-status', code, runtime, state: 'unknown', running: null, pid: null };
  }
  const managed = await validateManagedProcess(code);
  return {
    kind: 'service-status',
    code,
    runtime,
    state: managed ? 'running' : 'stopped',
    running: managed,
    pid: getManagedPid(code) ?? null,
  };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function collectCleanupError(errors: unknown[], cleanup: () => Promise<void>): Promise<void> {
  try {
    await cleanup();
  } catch (error) {
    errors.push(error);
  }
}

function withTimeout(operation: Promise<void>, timeoutMs: number, message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    void operation.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function createLocalControlSupervisor(
  options: LocalControlSupervisorOptions = {},
): LocalControlSupervisor {
  return new LocalControlSupervisor(options);
}
