/** @implements SPEC-EX-NETWATCH */
/**
 * 遮断の登録・解除・一覧。 対象の検証 → 希望状態の更新 → ファイルへの書き込みを 1 件ずつ行い、
 * 書けなければ巻き戻す。 反映 (ファイアウォール) は同期タスクの仕事で、 ここでは状況を読むだけ。
 */

import type { BlockEntry, BlockRegistry } from './block-registry.js';
import type { BlockSettings } from './block-settings.js';
import { validateBlockTarget, type BlockKind } from './block-target.js';
import { enforcementOf, type Enforcement, type SyncStatus } from './firewall-sync-status.js';

export interface BlockView extends BlockEntry {
  enforcement: Enforcement;
  enforcementReason: string | null;
}

export interface BlockOverview {
  /** ok = 登録できる。 disabled = 設定で止めている / 使えない環境。 failed = 遮断ファイルが壊れている。 */
  state: 'ok' | 'disabled' | 'failed';
  reason: string | null;
  sync: SyncStatus | null;
  blocks: BlockView[];
}

export interface AddBlockInput {
  kind: BlockKind;
  value: string;
  reason: string;
  /** 省略時は既定の期限。 */
  ttlMinutes?: number;
  actor: string;
}

export type BlockMutation<T> =
  | { ok: true; value: T }
  | { ok: false; status: 400 | 404 | 409 | 503; error: string; existing?: BlockEntry };

export interface BlockServiceDeps {
  registry: BlockRegistry;
  /** 今の設定。 disabled なら null と理由。 */
  settings: () => { settings: BlockSettings | null; reason: string | null };
  syncStatus: () => SyncStatus | null;
  /** 希望状態をファイルへ書く。 */
  persist: (content: string) => Promise<void>;
  now: () => number;
}

export class BlockService {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: BlockServiceDeps) {}

  overview(): BlockOverview {
    const { settings, reason } = this.deps.settings();
    const sync = this.deps.syncStatus();
    const health = this.deps.registry.status();
    const state = !settings ? 'disabled' : health.state === 'failed' ? 'failed' : 'ok';
    const blocks = this.deps.registry.list(this.deps.now()).map((entry) => {
      const enforcement = sync ? enforcementOf(entry, sync) : { enforcement: 'pending' as const, reason: null };
      return { ...entry, enforcement: enforcement.enforcement, enforcementReason: enforcement.reason };
    });
    return { state, reason: !settings ? reason : health.reason, sync, blocks };
  }

  add(input: AddBlockInput): Promise<BlockMutation<BlockEntry>> {
    return this.serialize(async () => {
      const ready = this.ready();
      if (!ready.ok) return ready;
      const settings = ready.value;
      const ttlMs = input.ttlMinutes === undefined ? settings.defaultTtlMs : input.ttlMinutes * 60_000;
      if (!Number.isInteger(input.ttlMinutes ?? 1) || ttlMs <= 0 || ttlMs > settings.maxTtlMs) {
        return { ok: false, status: 400, error: `ttl_minutes は 1〜${settings.maxTtlMs / 60_000} の整数` };
      }
      const target = validateBlockTarget(input.kind, input.value, settings.protection);
      if (!target.ok) return { ok: false, status: 400, error: target.reason };
      const before = this.deps.registry.snapshot();
      const added = this.deps.registry.add(target.target, input.reason, input.actor, this.deps.now(), ttlMs, settings.maxEntries);
      if (!added.ok) {
        return added.code === 'duplicate'
          ? { ok: false, status: 409, error: '同じ対象の遮断が期限内にある', existing: added.existing }
          : { ok: false, status: 409, error: `遮断は ${added.limit} 件まで` };
      }
      return this.commit(before, added.entry);
    });
  }

  remove(id: string): Promise<BlockMutation<BlockEntry>> {
    return this.serialize(async () => {
      const ready = this.ready();
      if (!ready.ok) return ready;
      const before = this.deps.registry.snapshot();
      const removed = this.deps.registry.remove(id);
      if (!removed) return { ok: false, status: 404, error: 'その遮断は無い' };
      return this.commit(before, removed);
    });
  }

  /** 期限切れを外してファイルを書き直す (周期処理から呼ぶ)。 */
  expire(): Promise<void> {
    return this.serialize(async () => {
      if (!this.ready().ok) return;
      const before = this.deps.registry.snapshot();
      if (!this.deps.registry.expire(this.deps.now())) return;
      await this.deps.persist(this.deps.registry.render()).catch((error: unknown) => {
        this.deps.registry.restore(before);
        throw error;
      });
    });
  }

  private ready(): BlockMutation<BlockSettings> {
    const { settings, reason } = this.deps.settings();
    if (!settings) return { ok: false, status: 503, error: reason ?? '遮断は無効' };
    const health = this.deps.registry.status();
    if (health.state === 'failed') return { ok: false, status: 503, error: health.reason };
    return { ok: true, value: settings };
  }

  private async commit(before: BlockEntry[], entry: BlockEntry): Promise<BlockMutation<BlockEntry>> {
    try {
      await this.deps.persist(this.deps.registry.render());
      return { ok: true, value: entry };
    } catch (error) {
      this.deps.registry.restore(before);
      return { ok: false, status: 503, error: `遮断ファイルを書けない: ${(error as Error).message}` };
    }
  }

  /** 変更を 1 件ずつ (ファイルの書き込みを重ねない)。 */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
