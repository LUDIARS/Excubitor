/**
 * 他拠点 Excubitor ピア (remote_peers) の永続化。
 *
 * base_url + token を保持し、 federation router が集約/操作の接続先として読む。
 * token は平文なので UI へ返すときは hint だけにする (full token は client が DB から直接読む)。
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

export interface RemotePeer {
  id: string;
  name: string;
  base_url: string;
  token: string;
  enabled: boolean;
  last_ok_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

/** token を伏せた UI 表示用ビュー (末尾 4 文字だけ hint)。 */
export interface PeerView {
  id: string;
  name: string;
  base_url: string;
  token_hint: string;
  enabled: boolean;
  last_ok_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

function tokenHint(token: string): string {
  if (token.length <= 4) return '****';
  return `…${token.slice(-4)}`;
}

export function toView(p: RemotePeer): PeerView {
  return {
    id: p.id,
    name: p.name,
    base_url: p.base_url,
    token_hint: tokenHint(p.token),
    enabled: p.enabled,
    last_ok_at: p.last_ok_at,
    last_error: p.last_error,
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}

function rowToPeer(r: Record<string, unknown>): RemotePeer {
  return {
    id: r.id as string,
    name: r.name as string,
    base_url: r.base_url as string,
    token: r.token as string,
    enabled: Number(r.enabled) === 1,
    last_ok_at: r.last_ok_at == null ? null : Number(r.last_ok_at),
    last_error: (r.last_error as string | null) ?? null,
    created_at: Number(r.created_at),
    updated_at: Number(r.updated_at),
  };
}

export function listPeers(): RemotePeer[] {
  const rows = db().all(sql`SELECT * FROM remote_peers ORDER BY name ASC`) as Array<Record<string, unknown>>;
  return rows.map(rowToPeer);
}

export function getPeer(id: string): RemotePeer | null {
  const rows = db().all(sql`SELECT * FROM remote_peers WHERE id = ${id} LIMIT 1`) as Array<Record<string, unknown>>;
  return rows[0] ? rowToPeer(rows[0]) : null;
}

export function createPeer(input: { name: string; base_url: string; token: string; enabled?: boolean }): RemotePeer {
  const id = randomUUID();
  // 末尾スラッシュは正規化して保存 (client が path を連結するため)。
  const base = input.base_url.replace(/\/+$/, '');
  db().run(sql`
    INSERT INTO remote_peers (id, name, base_url, token, enabled)
    VALUES (${id}, ${input.name}, ${base}, ${input.token}, ${input.enabled === false ? 0 : 1})
  `);
  return getPeer(id)!;
}

export function updatePeer(
  id: string,
  patch: { name?: string; base_url?: string; token?: string; enabled?: boolean },
): RemotePeer | null {
  const existing = getPeer(id);
  if (!existing) return null;
  const base = patch.base_url != null ? patch.base_url.replace(/\/+$/, '') : null;
  db().run(sql`
    UPDATE remote_peers SET
      name = COALESCE(${patch.name ?? null}, name),
      base_url = COALESCE(${base}, base_url),
      token = COALESCE(${patch.token ?? null}, token),
      enabled = COALESCE(${patch.enabled === undefined ? null : patch.enabled ? 1 : 0}, enabled),
      updated_at = unixepoch() * 1000
    WHERE id = ${id}
  `);
  return getPeer(id);
}

export function deletePeer(id: string): boolean {
  const res = db().run(sql`DELETE FROM remote_peers WHERE id = ${id}`);
  return (res.changes ?? 0) > 0;
}

/** 疎通結果を記録する (test / 集約時)。 */
export function markPeerResult(id: string, ok: boolean, error: string | null): void {
  if (ok) {
    db().run(sql`UPDATE remote_peers SET last_ok_at = unixepoch() * 1000, last_error = NULL, updated_at = unixepoch() * 1000 WHERE id = ${id}`);
  } else {
    db().run(sql`UPDATE remote_peers SET last_error = ${error}, updated_at = unixepoch() * 1000 WHERE id = ${id}`);
  }
}
