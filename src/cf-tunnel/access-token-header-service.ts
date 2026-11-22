/**
 * Access アプリの `read_service_tokens_from_header` (サービストークンを 1 つのヘッダで受ける設定) を
 * 読み書きする判断ロジック。CF の画面に無く API でしか入れられない設定。
 *
 * - 対象は allowlist の hostname と domain が完全一致する self-hosted アプリ 1 件だけ。
 * - CF のアプリ更新 (PUT) は全体置換なので、現行設定を保ったままこの 1 項目だけを変えた本体を作る。
 * - 応答に AUD を出さない (アプリ設定そのものは返さず id / name / domain とヘッダ名だけ)。
 *
 * CF API 呼び出しは `TokenHeaderAccessApi` (CloudflareAccessApi が満たす) 越しに行い、HTTP は router が持つ。
 *
 * @implements SPEC-CF-TUNNEL-ROUTES (spec/feature/cf-tunnel-routes.md 要求 11)
 */

import type { CfAccessApp } from './cloudflare-access-api.js';
import { isHostnameAllowed, RouteRejectedError } from './route-service.js';
import { contract } from '@ludiars/log-weaver'; /* augur-inject:import:c25ab2e4 */
import augurContract_8384a041 from './contracts/c-44.contract.js'; /* augur-inject:contract-predicate:e8c19b5f */
import augurContract_466a6230 from './contracts/c-45.contract.js'; /* augur-inject:contract-predicate:e92c996d */
import augurContract_0cf4b71f from './contracts/c-46.contract.js'; /* augur-inject:contract-predicate:7a7b70a3 */
import augurContract_7a891f79 from './contracts/c-47.contract.js'; /* augur-inject:contract-predicate:7046fa1c */

export const TOKEN_HEADER_FIELD = 'read_service_tokens_from_header';
/** RFC 7230 token (tchar の 1 文字以上)。長さは 64 文字までに絞る。 */
const HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,64}$/;
/** GET で返るが書き戻さない項目 (AUD は秘密に準じて扱うので送り返しもしない)。 */
const READ_ONLY_FIELDS = new Set(['id', 'uid', 'aud', 'created_at', 'updated_at']);

/** Access アプリ 1 件の設定 (CF が返す形のまま)。 */
export type AccessAppConfig = Record<string, unknown>;

/** @implements SPEC-CF-TUNNEL-ROUTES */
export interface TokenHeaderAccessApi {
  listApps(): Promise<CfAccessApp[]>;
  getApp(appId: string): Promise<AccessAppConfig>;
  updateApp(appId: string, config: AccessAppConfig): Promise<AccessAppConfig>;
}

export interface PublicAccessApp {
  id: string;
  name: string;
  domain: string;
}

/** ヘッダ名は RFC 7230 token の 1〜64 文字、外すときは null。 @implements SPEC-CF-TUNNEL-ROUTES */
export function assertTokenHeaderName(header: unknown): string | null {
  if (header === null) return null;
  if (typeof header !== 'string' || !HEADER_TOKEN.test(header)) {
    throw new RouteRejectedError('header はヘッダ名 (RFC 7230 token、1〜64 文字) か null (外す)');
  }
  return header;
}
// @ts-expect-error augur-inject
assertTokenHeaderName = contract(assertTokenHeaderName, { ...augurContract_0cf4b71f, contractId: 'C-46', mode: 'observe', sample: 1, where: 'src/cf-tunnel/access-token-header-service.ts:40', rule: 'contract-wrap', id: '0cf4b71f' }); /* augur-inject:contract-wrap:0cf4b71f */

/** hostname は CF Tunnel allowlist に載るものだけ。 @implements SPEC-CF-TUNNEL-ROUTES */
export function assertTokenHeaderHostname(hostname: unknown, allowlist: string[]): string {
  if (typeof hostname !== 'string' || hostname.trim() === '') throw new RouteRejectedError('hostname は必須');
  const host = hostname.trim().toLowerCase();
  if (!isHostnameAllowed(host, allowlist)) {
    throw new RouteRejectedError(
      `hostname "${host}" は allowlist (EXCUBITOR_CF_TUNNEL_ALLOWED_HOSTNAMES か設定 UI の CF Tunnel) に無いため扱えない`,
    );
  }
  return host;
}

/**
 * domain が hostname と完全一致する self-hosted アプリがちょうど 1 件のときだけ返す。
 * 0 件 (パス付きドメインのアプリしか無い場合を含む)・複数は入力拒否。
 * @implements SPEC-CF-TUNNEL-ROUTES
 */
export function selectTokenHeaderApp(apps: CfAccessApp[], hostname: string): CfAccessApp {
  const host = hostname.trim().toLowerCase();
  const domainOf = (a: CfAccessApp) => a.domain.trim().toLowerCase();
  const matches = apps.filter((a) => domainOf(a) === host && a.type === 'self_hosted');
  if (matches.length === 1 && matches[0]) return matches[0];
  if (matches.length > 1) {
    throw new RouteRejectedError(`"${host}" と domain が一致する self-hosted アプリが ${matches.length} 件あり、どれか決められない`);
  }
  if (apps.some((a) => domainOf(a).startsWith(`${host}/`))) {
    throw new RouteRejectedError(`"${host}" にはパス付きドメインの Access アプリしか無い (ホスト全体のアプリだけを扱う)`);
  }
  throw new RouteRejectedError(`"${host}" と domain が一致する self-hosted の Access アプリが無い`);
}
// @ts-expect-error augur-inject
selectTokenHeaderApp = contract(selectTokenHeaderApp, { ...augurContract_466a6230, contractId: 'C-45', mode: 'observe', sample: 1, where: 'src/cf-tunnel/access-token-header-service.ts:65', rule: 'contract-wrap', id: '466a6230' }); /* augur-inject:contract-wrap:466a6230 */

/** 現行値 (未設定・空文字は null)。 @implements SPEC-CF-TUNNEL-ROUTES */
export function readTokenHeader(config: AccessAppConfig): string | null {
  const value = config[TOKEN_HEADER_FIELD];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** 応答に出してよいアプリの識別情報 (AUD は含めない)。 @implements SPEC-CF-TUNNEL-ROUTES */
export function publicApp(app: CfAccessApp): PublicAccessApp {
  return { id: app.id, name: app.name, domain: app.domain };
}

export interface TokenHeaderPlan {
  before: string | null;
  after: string | null;
  changed: boolean;
  /** CF の PUT へそのまま送る本体 (全体置換)。応答・ログへは出さない。 */
  body: AccessAppConfig;
}

/**
 * GET した現行アプリ設定から、`read_service_tokens_from_header` だけを変えた PUT 本体を作る。
 * policies は付け替えを避けるため `{ id, precedence }` の参照形にする (中身を送ると再利用ポリシーの
 * 書き換えとして扱われうる)。null は項目を外す (全体置換なので送らなければ消える)。
 * @implements SPEC-CF-TUNNEL-ROUTES
 */
export function planTokenHeader(current: AccessAppConfig, header: string | null): TokenHeaderPlan {
  const body: AccessAppConfig = {};
  for (const [key, value] of Object.entries(current)) {
    if (!READ_ONLY_FIELDS.has(key) && key !== TOKEN_HEADER_FIELD) body[key] = value;
  }
  if (Array.isArray(current.policies)) body.policies = current.policies.map(policyReference);
  if (header !== null) body[TOKEN_HEADER_FIELD] = header;
  const before = readTokenHeader(current);
  return { before, after: header, changed: before !== header, body };
}
// @ts-expect-error augur-inject
planTokenHeader = contract(planTokenHeader, { ...augurContract_8384a041, contractId: 'C-44', mode: 'observe', sample: 1, where: 'src/cf-tunnel/access-token-header-service.ts:104', rule: 'contract-wrap', id: '8384a041' }); /* augur-inject:contract-wrap:8384a041 */

function policyReference(policy: unknown): unknown {
  if (policy === null || typeof policy !== 'object') return policy;
  const { id, precedence } = policy as { id?: unknown; precedence?: unknown };
  if (typeof id !== 'string') return policy;
  return typeof precedence === 'number' ? { id, precedence } : { id };
}

export interface TokenHeaderState {
  app: PublicAccessApp;
  read_service_tokens_from_header: string | null;
}

/** GET: hostname のアプリと現行のヘッダ名。 @implements SPEC-CF-TUNNEL-ROUTES */
export async function readTokenHeaderState(
  api: TokenHeaderAccessApi,
  allowlist: string[],
  hostname: unknown,
): Promise<TokenHeaderState> {
  const host = assertTokenHeaderHostname(hostname, allowlist);
  const app = selectTokenHeaderApp(await api.listApps(), host);
  const config = await api.getApp(app.id);
  return { app: publicApp(app), read_service_tokens_from_header: readTokenHeader(config) };
}

export interface TokenHeaderChangeInput {
  hostname: unknown;
  header: unknown;
  apply?: unknown;
}

export interface TokenHeaderChangeResult {
  /** true = 計画だけ (書いていない)。 */
  plan: boolean;
  applied: boolean;
  changed: boolean;
  app: PublicAccessApp;
  /** 戻すときはこの値を header にして同じ API を呼ぶ。 */
  before: string | null;
  after: string | null;
}

/**
 * PUT: 既定は計画だけ。`apply: true` かつ変化があるときだけ書き、書いた後に読み直して一致を確かめる。
 * @implements SPEC-CF-TUNNEL-ROUTES
 */
export async function changeTokenHeader(
  api: TokenHeaderAccessApi,
  allowlist: string[],
  input: TokenHeaderChangeInput,
): Promise<TokenHeaderChangeResult> {
  const header = assertTokenHeaderName(input.header);
  const host = assertTokenHeaderHostname(input.hostname, allowlist);
  const app = selectTokenHeaderApp(await api.listApps(), host);
  const plan = planTokenHeader(await api.getApp(app.id), header);
  const apply = input.apply === true;
  const base = { app: publicApp(app), before: plan.before, after: plan.after, changed: plan.changed };
  if (!apply || !plan.changed) return { plan: !apply, applied: false, ...base };
  await api.updateApp(app.id, plan.body);
  const written = readTokenHeader(await api.getApp(app.id));
  if (written !== plan.after) {
    throw new Error(`更新後に読み直した ${TOKEN_HEADER_FIELD} が要求と一致しない (戻すときは header=${JSON.stringify(plan.before)})`);
  }
  return { plan: false, applied: true, ...base };
}
// @ts-expect-error augur-inject
changeTokenHeader = contract(changeTokenHeader, { ...augurContract_7a891f79, contractId: 'C-47', mode: 'observe', sample: 1, where: 'src/cf-tunnel/access-token-header-service.ts:160', rule: 'contract-wrap', id: '7a891f79' }); /* augur-inject:contract-wrap:7a891f79 */
