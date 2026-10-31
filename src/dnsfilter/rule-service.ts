/** @implements SPEC-EX-DNS-FILTER */
/**
 * 拒否規則の登録・解除・一覧。 ドメインの検証 → 規則の更新 → ファイルへの書き込みを 1 件ずつ行い、
 * 書けなければ巻き戻す。 許可の一覧に当たるドメインは、 足しても効かないので受けない。
 */

import { normalizeDomain, type DomainSet } from './domain-rules.js';
import type { AddRuleResult, RuleEntry, RuleRegistry } from './rule-registry.js';

export interface RuleLimits {
  maxRules: number;
  /** 期限の上限 (ms)。 */
  maxTtlMs: number;
  /** 許可の一覧 (config)。 */
  allowed: DomainSet;
}

export interface RuleOverview {
  /** ok = 登録できる。 disabled = 設定で止めている。 failed = 規則ファイルが壊れている。 */
  state: 'ok' | 'disabled' | 'failed';
  reason: string | null;
  rules: RuleEntry[];
}

export interface AddRuleInput {
  domain: string;
  reason: string;
  /** 省略時は期限なし。 */
  ttlMinutes?: number;
  actor: string;
}

export type RuleMutation<T> =
  | { ok: true; value: T }
  | { ok: false; status: 400 | 404 | 409 | 503; error: string; existing?: RuleEntry };

export interface RuleServiceDeps {
  registry: RuleRegistry;
  /** 今の上限。 使えなければ null と理由。 */
  limits: () => { limits: RuleLimits | null; reason: string | null };
  persist: (content: string) => Promise<void>;
  now: () => number;
}

interface CheckedAdd {
  domain: string;
  /** 期限なしは null。 */
  ttlMs: number | null;
}

/** 期限とドメインを確かめる。 許可の一覧に当たるドメインは足しても効かないので断る。 */
function checkAddInput(input: AddRuleInput, limits: RuleLimits): RuleMutation<CheckedAdd> {
  let ttlMs: number | null = null;
  if (input.ttlMinutes !== undefined) {
    ttlMs = input.ttlMinutes * 60_000;
    if (!Number.isInteger(input.ttlMinutes) || ttlMs <= 0 || ttlMs > limits.maxTtlMs) {
      return { ok: false, status: 400, error: `ttl_minutes は 1〜${limits.maxTtlMs / 60_000} の整数 (省略で期限なし)` };
    }
  }
  const domain = normalizeDomain(input.domain);
  if (!domain.ok) return { ok: false, status: 400, error: domain.reason };
  const allowedBy = limits.allowed.match(domain.domain);
  if (allowedBy !== null) {
    return { ok: false, status: 409, error: `許可の一覧 (dns_filter.allowed_domains) の ${allowedBy} に当たるので効かない` };
  }
  return { ok: true, value: { domain: domain.domain, ttlMs } };
}

function addFailure(failure: Exclude<AddRuleResult, { ok: true }>): RuleMutation<RuleEntry> {
  return failure.code === 'duplicate'
    ? { ok: false, status: 409, error: '同じドメインの規則が期限内にある', existing: failure.existing }
    : { ok: false, status: 409, error: `規則は ${failure.limit} 件まで` };
}

export class RuleService {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: RuleServiceDeps) {}

  overview(): RuleOverview {
    const { limits, reason } = this.deps.limits();
    const health = this.deps.registry.status();
    const state = !limits ? 'disabled' : health.state === 'failed' ? 'failed' : 'ok';
    return { state, reason: !limits ? reason : health.reason, rules: this.deps.registry.list(this.deps.now()) };
  }

  add(input: AddRuleInput): Promise<RuleMutation<RuleEntry>> {
    return this.serialize(async () => {
      const ready = this.ready();
      if (!ready.ok) return ready;
      const checked = checkAddInput(input, ready.value);
      if (!checked.ok) return checked;
      const before = this.deps.registry.snapshot();
      const added = this.deps.registry.add(
        checked.value.domain, input.reason, input.actor, this.deps.now(), checked.value.ttlMs, ready.value.maxRules,
      );
      if (!added.ok) return addFailure(added);
      return this.commit(before, added.entry);
    });
  }

  remove(id: string): Promise<RuleMutation<RuleEntry>> {
    return this.serialize(async () => {
      const ready = this.ready();
      if (!ready.ok) return ready;
      const before = this.deps.registry.snapshot();
      const removed = this.deps.registry.remove(id);
      if (!removed) return { ok: false, status: 404, error: 'その規則は無い' };
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

  private ready(): RuleMutation<RuleLimits> {
    const { limits, reason } = this.deps.limits();
    if (!limits) return { ok: false, status: 503, error: reason ?? 'DNS フィルタは無効' };
    const health = this.deps.registry.status();
    if (health.state === 'failed') return { ok: false, status: 503, error: health.reason };
    return { ok: true, value: limits };
  }

  private async commit(before: RuleEntry[], entry: RuleEntry): Promise<RuleMutation<RuleEntry>> {
    try {
      await this.deps.persist(this.deps.registry.render());
      return { ok: true, value: entry };
    } catch (error) {
      this.deps.registry.restore(before);
      return { ok: false, status: 503, error: `規則ファイルを書けない: ${(error as Error).message}` };
    }
  }

  /** 変更を 1 件ずつ (ファイルの書き込みを重ねない)。 */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
