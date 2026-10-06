/**
 * 依頼 `concordia-federation-site`: 受けた拠点の Concordia に連合の拠点設定 (本社 URL / 拠点 ID / token) を入れる。
 *
 * Concordia の拠点設定 API (`PUT /v1/federation/site`) は loopback 限定なので、 拠点の外からは入れられない。
 * 本社の Concordia で拠点を登録して token を発行し、 相互登録済みの Excubitor 依頼で拠点へ運んで、
 * 拠点の Excubitor が自分の loopback から Concordia に書き込む (2026-10-06 neco 判断)。
 *
 * token の扱い:
 * - 依頼の記録 (DB の meta / 手順 / 履歴) には残さない。 受け付けたプロセスのメモリにだけ持ち、 実行したら捨てる。
 * - 待ち行列にいる間に Excubitor が再起動したら token は失われるので、 その依頼は失敗にする (再依頼してもらう)。
 * - Concordia の応答本文は手順に載せない (token は返らない契約だが、 念のため状態の要約だけ記録する)。
 */

import { z } from 'zod';
import type { Service } from '../../catalog/loader.js';
import { failed, succeeded, type ExecutionOutcome, type OperationContext } from './context.js';

/** @implements SPEC-FEDERATION-OPERATIONS */

export const CONCORDIA_SITE_ACTION = 'concordia-federation-site';
export const CONCORDIA_SERVICE_CODE = 'concordia';

/** Concordia の拠点 ID 規則 (Concordia src/federation/protocol.ts の SITE_ID_PATTERN) と揃える。 */
const SITE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

export const ConcordiaSiteOptionsSchema = z.object({
  hq_url: z.string().trim().min(1).max(500).refine((v) => /^wss?:\/\//.test(v), 'hq_url must be ws:// or wss://'),
  site_id: z.string().regex(SITE_ID_PATTERN),
  token: z.string().trim().min(1).max(500),
}).strict();
export type ConcordiaSiteOptions = z.infer<typeof ConcordiaSiteOptionsSchema>;

/** 記録に残してよい部分 (token を除く)。 */
export function publicSiteMeta(options: ConcordiaSiteOptions): { hq_url: string; site_id: string } {
  return { hq_url: options.hq_url, site_id: options.site_id };
}

/** 依頼 id → token。 プロセスのメモリだけに置く。 */
const pendingTokens = new Map<string, string>();

export function holdSiteToken(operationId: string, token: string): void {
  pendingTokens.set(operationId, token);
}

/** 取り出したら消す (1 回だけ使う)。 */
export function takeSiteToken(operationId: string): string | null {
  const token = pendingTokens.get(operationId) ?? null;
  pendingTokens.delete(operationId);
  return token;
}

export interface ConcordiaSiteDeps {
  fetch?: typeof fetch;
  takeToken?: (operationId: string) => string | null;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

interface SiteStatus {
  hqUrl?: string | null;
  siteId?: string | null;
  hasToken?: boolean;
  running?: unknown;
}

export async function runConcordiaSiteOperation(
  ctx: OperationContext,
  svc: Service | undefined,
  deps: ConcordiaSiteDeps = {},
): Promise<ExecutionOutcome> {
  const doFetch = deps.fetch ?? fetch;
  const token = (deps.takeToken ?? takeSiteToken)(ctx.op.id);
  if (!token) {
    ctx.record({ step: 'validate', ok: false, detail: 'token がありません (受け付け後に Excubitor が再起動した可能性)。依頼し直してください' });
    return failed('token_unavailable');
  }
  const meta = z.object({ hq_url: z.string(), site_id: z.string() }).safeParse(ctx.op.meta.federation_site);
  if (!meta.success) return failed('federation_site options missing');
  if (!svc || typeof svc.port !== 'number') {
    ctx.record({ step: 'validate', ok: false, detail: 'concordia の port が catalog にありません' });
    return failed('concordia_port_unknown');
  }
  const base = `http://127.0.0.1:${svc.port}/v1/federation/site`;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  ctx.record({ step: 'validate', ok: true, detail: `site_id=${meta.data.site_id} hq_url=${meta.data.hq_url}` });

  let res: Response;
  try {
    res = await doFetch(base, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hq_url: meta.data.hq_url, site_id: meta.data.site_id, token }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    ctx.record({ step: 'apply', ok: false, detail: `Concordia に繋がりません: ${(err as Error).message}` });
    return failed('concordia_unreachable');
  }
  if (!res.ok) {
    const error = await readError(res);
    ctx.record({ step: 'apply', ok: false, detail: `Concordia が拒否しました (${res.status}): ${error}` });
    return failed(`concordia_rejected_${res.status}`);
  }
  const applied = (await res.json().catch(() => null)) as SiteStatus | null;
  const ok = applied?.siteId === meta.data.site_id && applied?.hqUrl === meta.data.hq_url && applied?.hasToken === true;
  ctx.record({
    step: 'apply',
    ok,
    detail: ok
      ? `拠点設定を保存しました (running=${applied?.running ? 'yes' : 'no'})`
      : '保存後の設定が依頼と一致しません',
  });
  return ok ? succeeded() : failed('concordia_site_mismatch');
}

/** エラー本文から error フィールドだけを短く取り出す (本文全体は記録しない)。 */
async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  const text = typeof body?.error === 'string' ? body.error : 'unknown';
  return text.slice(0, 200);
}
