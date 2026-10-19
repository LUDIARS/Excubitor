/**
 * 他拠点 Excubitor ピアへの HTTP クライアント。
 *
 * peer 固定の認証方式を security/client-auth.ts で選ぶ。Cr workload token と
 * Ed25519 proof が標準で、旧共有鍵は明示した監視専用 peer にのみ使用する。
 * ピアが Cloudflare Access の後ろにある場合は CF-Access Service Token ヘッダも付与する。
 * 失敗 (接続不可 / 認証エラー / タイムアウト) は throw せず {ok:false} を返し、 集約は degrade する。
 */

import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { RemotePeer } from './store.js';
import { meshRequestHeaders } from './security/client-auth.js';
import type { OperationRequest } from './operations/types.js';
import { operationScope } from './security/operation-scope.js';
import { REAUTHORIZE_PATH, reauthorizationRequest, type ReauthorizationScope } from './security/reauthorization.js';

/** @implements SPEC-FEDERATION-MUTUAL-AUTH */

export interface PeerCallResult<T> {
  ok: boolean;
  status: number | null;
  data: T | null;
  error: string | null;
}

const DEFAULT_TIMEOUT_MS = 8000;

async function call<T>(
  peer: RemotePeer,
  method: 'GET' | 'POST',
  path: string,
  action: string,
  resource: string,
  payload?: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<PeerCallResult<T>> {
  const body = payload !== undefined ? JSON.stringify(payload) : '';
  try {
    const res = await fetch(`${peer.base_url}${path}`, {
      method,
      headers: await meshRequestHeaders(peer, method, path, body, action, resource),
      redirect: 'error',
      body: body || undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let data: T | null = null;
    try {
      data = text ? (JSON.parse(text) as T) : null;
    } catch {
      // JSON でない応答 (プロキシのエラーページ等) は data 無しで返し、 status で判断させる。
      data = null;
    }
    if (!res.ok) {
      const code = (data as { error?: unknown } | null)?.error;
      return { ok: false, status: res.status, data, error: typeof code === 'string' ? `HTTP ${res.status} ${code}` : `HTTP ${res.status}` };
    }
    return { ok: true, status: res.status, data, error: null };
  } catch (err) {
    return { ok: false, status: null, data: null, error: (err as Error).message };
  }
}

export interface RemoteNodeSnapshot {
  node: string;
  summary: Record<string, unknown>;
  services: Array<Record<string, unknown>>;
  host: Record<string, unknown> | null;
}

/** ピアのノードスナップショット (サマリ + サービス一覧 + host メトリクス) を取得。 */
export function fetchNode(peer: RemotePeer): Promise<PeerCallResult<RemoteNodeSnapshot>> {
  return call<RemoteNodeSnapshot>(peer, 'GET', '/api/v1/federation/node', 'monitor', 'node:self');
}

/**
 * ピアの health (担保サービス + キャッシュ済み死活 + ピアから見たつながり) を取得。
 * 応答は未検証の JSON のまま返す (検証は呼び出し側が health-types のスキーマで行う)。
 */
export function fetchHealth(peer: RemotePeer, timeoutMs: number): Promise<PeerCallResult<unknown>> {
  return call<unknown>(peer, 'GET', '/api/v1/federation/health', 'monitor', 'node:self', undefined, timeoutMs);
}

/** ピアへ依頼を出す (受け付けられると 202 と依頼の要約が返る)。 */
export function requestOperation(peer: RemotePeer, request: OperationRequest): Promise<PeerCallResult<unknown>> {
  const { action, resource } = operationScope(request);
  return call<unknown>(peer, 'POST', '/api/v1/federation/operations', action, resource, request, 15_000);
}

/** 受けた依頼が待ち行列で認可期限を過ぎたとき、依頼元へ同じ範囲の実行 token を取り直しに行く。 */
export function requestReauthorization(peer: RemotePeer, scope: ReauthorizationScope): Promise<PeerCallResult<unknown>> {
  return call<unknown>(peer, 'POST', REAUTHORIZE_PATH, 'monitor', 'node:self', reauthorizationRequest(scope), 15_000);
}

/** 本社 (Vault の取得元) からサービスの Vault 値を受け取る。応答は未検証 (vault-inject.ts で検証)。 */
export function fetchVaultEnv(peer: RemotePeer, service: string): Promise<PeerCallResult<unknown>> {
  return call<unknown>(peer, 'POST', '/api/v1/federation/vault/env', 'vault', `service:${service}`, { service }, 10_000);
}

/** ピアに出した依頼の状態 (手順つき) を取得。 */
export function fetchOperation(peer: RemotePeer, id: string): Promise<PeerCallResult<unknown>> {
  return call<unknown>(peer, 'GET', `/api/v1/federation/operations/${encodeURIComponent(id)}`, 'monitor', 'node:self');
}

export interface BundleDownloadResult {
  ok: boolean;
  /** 相手の main が手元と同じで、 取り込むコミットが無い。 */
  upToDate: boolean;
  status: number | null;
  error: string | null;
}

/** 大きいリポジトリの全量 bundle もありうるので、 取得のタイムアウトは長めにとる。 */
const BUNDLE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * ピアから git bundle (repo の main、 have 以降) を受け取り、 destPath へ書く。
 * have は手元の HEAD (相手が持っていれば差分だけになる)。
 */
export async function downloadBundle(
  peer: RemotePeer,
  repo: string,
  have: string | null,
  destPath: string,
): Promise<BundleDownloadResult> {
  const query = new URLSearchParams({ repo, ...(have ? { have } : {}) });
  const path = `/api/v1/federation/git/bundle?${query.toString()}`;
  try {
    const res = await fetch(`${peer.base_url}${path}`, {
      method: 'GET',
      headers: await meshRequestHeaders(peer, 'GET', path, '', 'bundle', `repository:${repo}`),
      redirect: 'error',
      signal: AbortSignal.timeout(BUNDLE_TIMEOUT_MS),
    });
    if (res.status === 204) return { ok: true, upToDate: true, status: 204, error: null };
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      return { ok: false, upToDate: false, status: res.status, error: `HTTP ${res.status} ${text.slice(0, 300)}`.trim() };
    }
    await pipeline(Readable.fromWeb(res.body as WebReadableStream<Uint8Array>), createWriteStream(destPath));
    return { ok: true, upToDate: false, status: res.status, error: null };
  } catch (err) {
    return { ok: false, upToDate: false, status: null, error: (err as Error).message };
  }
}
