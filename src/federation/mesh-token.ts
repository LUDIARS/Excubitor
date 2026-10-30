/**
 * 拠点間 (federation legacy-monitor) 認証用の token。 secret-agent の token とは分ける。
 *
 * 旧版は secret-agent の token を拠点間の Bearer / HMAC 鍵にも使っていた。 そのため他拠点に登録した
 * token (相手の remote_peers に保存される) が漏れると、 この拠点の secret-agent から Vault の値を
 * 取り出せた。 用途ごとに分け、 拠点間 token は secret-agent では受けない。
 *
 * 出所 (優先順):
 *   1. env EXCUBITOR_MESH_TOKEN (明示指定)
 *   2. トークンファイル `mesh.token` (EXCUBITOR_MESH_TOKEN_PATH で上書き可)。 本人のみ読める (0600)。
 *   3. ファイルが無ければ **旧 secret-agent token の値で作る**。 既存拠点の相手側に登録済みの token を
 *      そのまま使い続けるため (更新しただけで拠点監視が切れない)。 値の入れ替え手順は spec を参照。
 *
 * 値は API (/api/v1/federation/self) では返さない。 ピア登録には `npm run agent-token -- mesh` で
 * 管理者が取り出す (ファイル ACL で守られた経路)。
 *
 * @implements SPEC-SECURITY-AGENT-TOKEN-SPLIT
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createNamedLogger } from '../shared/logger.js';
import { excubitorConfigDir } from '../secrets/config-dir.js';
import { getOrCreateAgentToken } from '../secrets/agent-token.js';

const logger = createNamedLogger('excubitor.federation.mesh-token');

export function meshTokenPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.EXCUBITOR_MESH_TOKEN_PATH;
  return override && override.length > 0 ? override : join(excubitorConfigDir(env), 'mesh.token');
}

let cached: { key: string; token: string } | null = null;

export function getOrCreateMeshToken(): string {
  const fromEnv = process.env.EXCUBITOR_MESH_TOKEN;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  const path = meshTokenPath();
  if (cached?.key === path) return cached.token;
  const token = readToken(path) ?? seedFromLegacy(path);
  cached = { key: path, token };
  return token;
}

function readToken(path: string): string | null {
  if (!existsSync(path)) return null;
  const token = readFileSync(path, 'utf8').trim();
  return token.length > 0 ? token : null;
}

function seedFromLegacy(path: string): string {
  const token = getOrCreateAgentToken();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, token, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    logger.warn({ path }, 'mesh token initialised from the legacy shared agent token; rotate it after peers are updated');
    return token;
  } catch (err) {
    // 同時生成に負けた側は勝った側の値を使う。 書けない環境ではメモリ上の値で続ける。
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return readToken(path) ?? token;
    logger.warn({ err: (err as Error).message }, 'failed to persist mesh token (using in-memory)');
    return token;
  }
}

/**
 * mesh token を新しいランダム値に入れ替える (管理者コマンド)。 旧共有 token と値を分けるための手順。
 * 稼働中の Ex はメモリ上の値を使い続けるので、 反映は Ex の再起動。 相手拠点の登録も入れ替える必要がある。
 */
export function rotateMeshToken(): string {
  if (process.env.EXCUBITOR_MESH_TOKEN) throw new Error('EXCUBITOR_MESH_TOKEN is set; rotate it in the site env instead');
  const path = meshTokenPath();
  const token = randomBytes(32).toString('hex');
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, token, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
  cached = { key: path, token };
  return token;
}

/** Authorization ヘッダ値 (`Bearer xxx` or 生 token) を mesh token と定数時間で比較する。 */
export function verifyMeshToken(headerValue: string | undefined | null): boolean {
  if (!headerValue) return false;
  const provided = headerValue.toLowerCase().startsWith('bearer ') ? headerValue.slice(7).trim() : headerValue.trim();
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(getOrCreateMeshToken());
  return a.length === b.length && timingSafeEqual(a, b);
}
