import type { Service } from '../catalog/loader.js';
import type { ControlResult } from '../control/docker-compose.js';
import { controlService } from '../control/manager.js';
import {
  isAdoptedProcess,
  isServiceDesiredRunning,
  listAdoptedProcessCodes,
  validateManagedProcess,
} from '../process/manager.js';
import { targetKey } from './protocol.js';
import { TargetOperationQueue } from './target-queue.js';

const DEFAULT_REAP_INTERVAL_MS = 5_000;

export interface AdoptedProcessReaperOptions {
  queue: TargetOperationQueue;
  refreshCatalog: () => Promise<unknown>;
  service: (code: string) => Service | undefined;
  intervalMs?: number;
  listAdopted?: () => string[];
  isAdopted?: (code: string) => boolean;
  shouldRecover?: (code: string) => boolean;
  validateManaged?: (code: string) => Promise<boolean>;
  control?: (service: Service, action: 'start', actor: string) => Promise<ControlResult>;
  onError?: (error: Error, code?: string) => void;
}

/**
 * Reaps stale process identities adopted during supervisor boot and retries
 * catalog-authorized recovery without racing explicit service operations.
 */
export class AdoptedProcessReaper {
  /**
   * code -> これまでに recovery で spawn し直した回数。 `max_restart` の上限判定に使う。
   *
   * **spawn が成功しても消さない。** recovery の spawn はほぼ必ず成功するので、 成功でリセットすると
   * 上限に永遠に到達せず、 誤判定が続く限り無制限に重複起動し続ける (稼働中の実体が port を奪われて落ちる)。
   * リセットするのは `validateManaged` が通った = サービスが実際に生きていると確認できたときだけ、
   * および復旧対象から外れたとき。
   */
  private readonly retryCounts = new Map<string, number>();
  private readonly intervalMs: number;
  private readonly listAdopted: () => string[];
  private readonly validateManaged: (code: string) => Promise<boolean>;
  private readonly isAdopted: (code: string) => boolean;
  private readonly shouldRecover: (code: string) => boolean;
  private readonly control: NonNullable<AdoptedProcessReaperOptions['control']>;
  private timer: NodeJS.Timeout | null = null;
  private tickTail: Promise<void> = Promise.resolve();
  private stopped = true;

  constructor(private readonly options: AdoptedProcessReaperOptions) {
    this.intervalMs = options.intervalMs ?? DEFAULT_REAP_INTERVAL_MS;
    this.listAdopted = options.listAdopted ?? listAdoptedProcessCodes;
    this.isAdopted = options.isAdopted ?? isAdoptedProcess;
    this.shouldRecover = options.shouldRecover ?? isServiceDesiredRunning;
    this.validateManaged = options.validateManaged ?? validateManagedProcess;
    this.control = options.control ?? controlService;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule();
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.tickTail;
    this.retryCounts.clear();
  }

  async runOnce(): Promise<void> {
    await this.options.refreshCatalog();
    const retryCandidates = new Set(this.retryCounts.keys());
    const candidates = new Set([...this.listAdopted(), ...retryCandidates]);
    await Promise.all(Array.from(candidates, async (code) => {
      try {
        await this.options.queue.run(targetKey({ kind: 'service', code }), async () => {
          // An explicit stop may remove the adopted entry while this check is
          // queued. Only retry entries may recover without a current adoption.
          if (!retryCandidates.has(code) && !this.isAdopted(code)) return;
          if (!this.shouldRecover(code)) {
            this.retryCounts.delete(code);
            return;
          }
          await this.reap(code);
        });
      } catch (error) {
        this.options.onError?.(asError(error), code);
      }
    }));
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tickTail = this.tickTail
        .then(() => this.runOnce())
        .catch((error: unknown) => this.options.onError?.(asError(error)))
        .finally(() => this.schedule());
    }, this.intervalMs);
    this.timer.unref?.();
  }

  private async reap(code: string): Promise<void> {
    if (await this.validateManaged(code)) {
      this.retryCounts.delete(code);
      return;
    }

    const service = this.options.service(code);
    if (!service || service.disabled || service.restart_policy === 'no') {
      this.retryCounts.delete(code);
      return;
    }

    const attempts = this.retryCounts.get(code) ?? 0;
    const maximum = Math.max(0, Math.trunc(service.max_restart));
    if (attempts >= maximum) return;

    this.retryCounts.set(code, attempts + 1);
    await this.control(service, 'start', 'supervisor-adopted-recovery');
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
