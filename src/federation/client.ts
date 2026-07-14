/**
 * 他拠点 Excubitor ピアへの HTTP クライアント。
 *
 * ピアの base_url + token を使って相手の federation API (`/api/v1/federation/*`) を叩く。
 * すべて Authorization: Bearer <peer.token> を付ける (相手ノードの agent token と一致する想定)。
 * ピアが Cloudflare Access の後ろにある場合は CF-Access Service Token ヘッダも付与し、
 * Access 境界を突破する (origin で agent token が本番 authz)。
 * 失敗 (接続不可 / 認証エラー / タイムアウト) は throw せず {ok:false} を返し、 集約は degrade する。
 */

import type { RemotePeer } from './store.js';

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
  body?: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<PeerCallResult<T>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${peer.base_url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${peer.token}`,
        ...(peer.cf_access_id && peer.cf_access_secret
          ? { 'CF-Access-Client-Id': peer.cf_access_id, 'CF-Access-Client-Secret': peer.cf_access_secret }
          : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data: T | null = null;
    try {
      data = text ? (JSON.parse(text) as T) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      return { ok: false, status: res.status, data, error: `HTTP ${res.status}` };
    }
    return { ok: true, status: res.status, data, error: null };
  } catch (err) {
    return { ok: false, status: null, data: null, error: (err as Error).message };
  } finally {
    clearTimeout(timer);
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
  return call<RemoteNodeSnapshot>(peer, 'GET', '/api/v1/federation/node');
}

/** ピアの 1 サービスを start/stop/restart する。 */
export function remoteControl(
  peer: RemotePeer,
  code: string,
  action: 'start' | 'stop' | 'restart',
): Promise<PeerCallResult<Record<string, unknown>>> {
  return call(peer, 'POST', '/api/v1/federation/control', { code, action }, 60_000);
}

/** ピアの 1 サービスを update (pull + install + restart) する。 */
export function remoteUpdate(
  peer: RemotePeer,
  code: string,
  opts: { install?: boolean; restart?: boolean },
): Promise<PeerCallResult<Record<string, unknown>>> {
  return call(peer, 'POST', '/api/v1/federation/update', { code, ...opts }, 600_000);
}
