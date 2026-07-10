import { resolve } from 'node:path';
import { Worker } from 'node:worker_threads';

import type { DowntimeSummary } from './downtime.js';
import type { DowntimeSummaryReader } from './downtime-reader.js';

interface DowntimeWorkerResponse {
  id: number;
  ok: boolean;
  summaries?: Array<[string, DowntimeSummary]>;
  error?: string;
}

interface PendingRequest {
  resolve: (value: Map<string, DowntimeSummary>) => void;
  reject: (reason: Error) => void;
}

/** Owns the read-only SQLite worker used by HTTP downtime read models. */
export class DowntimeWorkerClient {
  readonly read: DowntimeSummaryReader;

  #worker: Worker;
  #pending = new Map<number, PendingRequest>();
  #nextId = 1;
  #closed = false;
  #failure: Error | null = null;

  constructor(dbPath: string) {
    this.#worker = new Worker(new URL('./downtime-worker.js', import.meta.url), {
      workerData: { dbPath: resolve(dbPath) },
    });
    this.#worker.unref();
    this.#worker.on('message', (message: DowntimeWorkerResponse) => this.#onMessage(message));
    this.#worker.on('error', (error) => this.#markFailed(error));
    this.#worker.on('exit', (code) => {
      if (!this.#closed) this.#markFailed(new Error(`downtime worker exited unexpectedly (code=${code})`));
    });
    this.read = (codes, windowMin, now) => this.#request(codes, windowMin, now);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#failPending(new Error('downtime worker closed'));
    await this.#worker.terminate();
  }

  #request(codes: string[], windowMin?: number, now?: number): Promise<Map<string, DowntimeSummary>> {
    if (this.#closed) return Promise.reject(new Error('downtime worker is closed'));
    if (this.#failure) return Promise.reject(this.#failure);
    const id = this.#nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      this.#pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
      this.#worker.postMessage({ id, codes, windowMin, now });
    });
  }

  #onMessage(message: DowntimeWorkerResponse): void {
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    if (!message.ok) {
      pending.reject(new Error(message.error ?? 'downtime worker query failed'));
      return;
    }
    pending.resolve(new Map(message.summaries ?? []));
  }

  #failPending(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  #markFailed(error: Error): void {
    this.#failure ??= error;
    this.#failPending(this.#failure);
  }
}
